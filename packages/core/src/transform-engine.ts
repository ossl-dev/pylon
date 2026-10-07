import type {
  SchemaMap,
  TransformDirection,
  TransformErrorConfig,
  TransformPair,
  TransformResult,
} from './types.js';
import type { VersionNormalizer } from './version-normalizer.js';

/**
 * Error thrown when a transform operation fails.
 */
export class TransformError extends Error {
  /** Error code for programmatic handling */
  code: string;
  /** Additional details about the error */
  details?: Record<string, any>;

  constructor(message: string, code: string = 'TRANSFORM_ERROR', details?: Record<string, any>) {
    super(message);
    this.name = 'TransformError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Builds and executes transform chains between API versions.
 *
 * Walks the version graph using normalized order indices, composing
 * adjacent version transforms into a single function via composition.
 * Supports multiple error strategies: reject, fallback, passthrough,
 * and log-and-continue.
 */
export class TransformEngine {
  private transforms: Map<string, TransformPair>;
  private schemas: SchemaMap;
  private normalizer: VersionNormalizer;
  private compiledCache: Map<string, Function>;

  constructor(
    transforms: Record<string, TransformPair>,
    schemas: SchemaMap,
    normalizer: VersionNormalizer,
  ) {
    this.transforms = new Map(Object.entries(transforms));
    this.schemas = schemas;
    this.normalizer = normalizer;
    this.compiledCache = new Map();
  }

  /**
   * Build a transform chain from source to target version.
   *
   * Walks the version graph using normalized order. Each hop between
   * adjacent versions must have a registered transform keyed as
   * `{lower}->{higher}`.
   *
   * @param source - The source version string
   * @param target - The target version string
   * @returns Array of transform keys representing the chain, e.g. `['v1->v2', 'v2->v3']`
   * @throws {TransformError} If any hop in the chain is missing
   */
  buildChain(source: string, target: string): string[] {
    const sourceOrder = this.normalizer.normalize(source);
    const targetOrder = this.normalizer.normalize(target);

    if (sourceOrder === null) {
      throw new TransformError(`Unknown source version: "${source}"`, 'INVALID_SOURCE_VERSION', {
        source,
      });
    }

    if (targetOrder === null) {
      throw new TransformError(`Unknown target version: "${target}"`, 'INVALID_TARGET_VERSION', {
        target,
      });
    }

    this.validateChain(source, target);

    if (sourceOrder === targetOrder) {
      return [];
    }

    const chain: string[] = [];
    let current: string = source;

    if (sourceOrder < targetOrder) {
      // Walk forward (request direction: old -> new)
      for (let order = sourceOrder; order < targetOrder; order++) {
        const next = this.normalizer.denormalize(order + 1);
        if (!next) {
          throw new TransformError(`Missing version at order ${order + 1}`, 'MISSING_VERSION', {
            order: order + 1,
          });
        }
        const key = `${current}->${next}`;
        if (!this.transforms.has(key)) {
          throw new TransformError(`Missing transform: ${key}`, 'MISSING_TRANSFORM', {
            source: current,
            target: next,
            key,
          });
        }
        chain.push(key);
        current = next;
      }
    } else {
      // Walk backward (response direction: new -> old)
      // Response transforms can be registered TWO ways:
      // 1. As backward key: 'v2->v1' with { response: fn }
      // 2. As forward key: 'v1->v2' with { request: fnReq, response: fnRes }
      for (let order = sourceOrder; order > targetOrder; order--) {
        const prev = this.normalizer.denormalize(order - 1);
        if (!prev) {
          throw new TransformError(`Missing version at order ${order - 1}`, 'MISSING_VERSION', {
            order: order - 1,
          });
        }
        // Try backward key first, then forward key
        const backwardKey = `${current}->${prev}`;
        const forwardKey = `${prev}->${current}`;
        const key = this.transforms.has(backwardKey) ? backwardKey : forwardKey;
        if (!this.transforms.has(key)) {
          throw new TransformError(
            `Missing transform: ${backwardKey} or ${forwardKey}`,
            'MISSING_TRANSFORM',
            { source: current, target: prev, backwardKey, forwardKey },
          );
        }
        chain.push(key);
        current = prev;
      }
    }

    return chain;
  }

  /**
   * Compose transforms for a given source/target/direction into a single function.
   *
   * Uses memoization via a cache keyed by `{source}:{target}:{direction}`.
   * Returns an identity function when `source === target`.
   *
   * @param source - Source version
   * @param target - Target version
   * @param direction - Transform direction (`'request'` or `'response'`)
   * @returns A function that applies all transforms in sequence
   */
  compile(
    source: string,
    target: string,
    direction: TransformDirection,
  ): (input: any) => any | Promise<any> {
    if (source === target) {
      return (input: any) => input;
    }

    const cacheKey = `${source}:${target}:${direction}`;
    const cached = this.compiledCache.get(cacheKey);
    if (cached) return cached as (input: any) => any | Promise<any>;

    const chain = this.buildChain(source, target);
    const fnName = direction === 'request' ? 'request' : 'response';

    // Compose functions: for request direction, apply transforms left to right
    // For response direction, apply transforms in reverse (the chain was built from
    // current back to client version, but transforms are registered as request-direction)
    const fns: Function[] = [];
    if (direction === 'request') {
      for (const key of chain) {
        const pair = this.transforms.get(key);
        const fn = pair?.[fnName];
        if (fn) fns.push(fn);
      }
    } else {
      // Response transforms: we need the reverse transforms
      // The chain is built from current -> old, but we need response transforms
      // registered on those pairs, or inverted request transforms
      for (const key of chain) {
        const pair = this.transforms.get(key);
        const fn = pair?.[fnName];
        if (fn) fns.push(fn);
      }
    }

    const composed = async (input: any): Promise<any> => {
      let result = input;
      for (const fn of fns) {
        result = await fn(result);
      }
      return result;
    };

    this.compiledCache.set(cacheKey, composed);
    return composed;
  }

  /**
   * Execute transforms for the given source/target/direction.
   *
   * Handles error strategies specified on each transform pair:
   * - `reject`: throws a `TransformError`
   * - `fallback`: calls the fallback function with the input
   * - `passthrough`: returns the input unchanged
   * - `log-and-continue`: logs the error and continues with partial data
   *
   * @param source - Source version
   * @param target - Target version
   * @param direction - Transform direction
   * @param input - The data to transform
   * @param onError - Optional error callback for logging
   * @returns Transform result with status and data
   */
  async execute(
    source: string,
    target: string,
    direction: TransformDirection,
    input: any,
    onError?: (err: any) => void,
  ): Promise<TransformResult> {
    if (source === target) {
      return { status: 'success', data: input };
    }

    if (input === null || input === undefined) {
      return { status: 'success', data: input };
    }

    const chain = this.buildChain(source, target);

    try {
      let data = input;
      const fnName = direction === 'request' ? 'request' : 'response';

      for (const key of chain) {
        const pair = this.transforms.get(key);
        if (!pair) continue;

        const fn = pair[fnName];
        if (!fn) continue;

        const errorConfig = pair.onError;

        try {
          data = await fn(data);
        } catch (err: any) {
          onError?.(err);

          if (errorConfig) {
            const result = this.applyErrorStrategy(errorConfig, data, err, direction);
            if (result.status !== 'success' || result.data !== undefined) {
              return result;
            }
            // For log-and-continue, data stays as-is (partial)
          } else {
            // No error config on this pair, re-throw
            throw err;
          }
        }
      }

      return { status: 'success', data };
    } catch (err: any) {
      const transformError =
        err instanceof TransformError
          ? err
          : new TransformError(err.message ?? 'Transform execution failed', 'EXECUTION_ERROR');

      onError?.(transformError);

      // Check if the overall config has an error handler
      return {
        status: 'error',
        error: {
          code: transformError.code,
          message: transformError.message,
          details: transformError.details,
        },
      };
    }
  }

  /**
   * Apply an error strategy when a transform function fails.
   */
  private applyErrorStrategy(
    strategy: TransformErrorConfig | undefined,
    input: any,
    error: Error,
    _direction: TransformDirection,
  ): TransformResult {
    if (!strategy) {
      throw error;
    }

    switch (strategy.strategy) {
      case 'reject':
        throw new TransformError(error.message, strategy.errorCode ?? 'TRANSFORM_REJECTED', {
          originalError: error.message,
        });

      case 'fallback':
        if (strategy.fallback) {
          try {
            const fallbackResult = strategy.fallback(input);
            return { status: 'fallback', data: fallbackResult };
          } catch (fallbackErr: any) {
            throw new TransformError(`Fallback failed: ${fallbackErr.message}`, 'FALLBACK_FAILED', {
              originalError: error.message,
              fallbackError: fallbackErr.message,
            });
          }
        }
        throw new TransformError(error.message, 'FALLBACK_NOT_CONFIGURED', {
          originalError: error.message,
        });

      case 'passthrough':
        return { status: 'passthrough', data: input };

      case 'log-and-continue':
        // Return undefined data to signal "continue with existing data"
        return { status: 'success', data: undefined };

      default:
        throw error;
    }
  }

  /**
   * Validate that the source -> target chain makes sense.
   *
   * Ensures the transform direction aligns with the version order:
   * - Request transforms go from lower order to higher order (old -> new)
   * - Response transforms go from higher order to lower order (new -> old)
   *
   * @throws {TransformError} If the chain direction is invalid
   */
  private validateChain(source: string, target: string): void {
    const sourceOrder = this.normalizer.normalize(source);
    const targetOrder = this.normalizer.normalize(target);

    if (sourceOrder === null || targetOrder === null) return;

    // No validation needed beyond existence — both forward and backward chains are valid
  }

  /**
   * Merge endpoint-specific transforms with the global transforms.
   *
   * Endpoint transforms override global transforms for matching keys.
   * Returns a new `TransformEngine` instance with the merged configuration.
   *
   * @param endpointTransforms - Endpoint-specific transform pairs
   * @returns A new TransformEngine with merged transforms
   */
  merge(endpointTransforms: Record<string, TransformPair>): TransformEngine {
    const merged = new Map(this.transforms);

    for (const [key, pair] of Object.entries(endpointTransforms)) {
      const existing = merged.get(key);
      if (existing) {
        merged.set(key, {
          request: pair.request ?? existing.request,
          response: pair.response ?? existing.response,
          onError: pair.onError ?? existing.onError,
        });
      } else {
        merged.set(key, pair);
      }
    }

    const engine = new TransformEngine(Object.fromEntries(merged), this.schemas, this.normalizer);
    engine.compiledCache = this.compiledCache;
    return engine;
  }
}
