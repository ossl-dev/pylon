import { z } from 'zod';
import type {
  ContractMap,
  SchemaMap,
  TransformDirection,
  TransformPair,
  TransformResult,
} from './types.js';
import type { VersionNormalizer } from './version-normalizer.js';

export interface TransformTraceStep {
  key: string;
  direction: TransformDirection;
  input: unknown;
  output: unknown;
  status: TransformResult['status'];
  durationMs: number;
  error?: TransformResult['error'];
}
export interface TransformTrace {
  result: TransformResult;
  steps: TransformTraceStep[];
}

type TransformFunction = Exclude<NonNullable<TransformPair['request']>, 'identity'>;
interface TransformStep {
  key: string;
  pair: TransformPair;
  fn: TransformFunction;
  schema?: z.ZodTypeAny;
}
const emptySchema = z.undefined();
const identity: TransformFunction = (input) => input;

export class TransformError extends Error {
  constructor(
    message: string,
    public code = 'TRANSFORM_ERROR',
    public details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TransformError';
  }
}

/** Executes adjacent version hops. Caches belong to one transform configuration. */
export class TransformEngine {
  private transforms: Map<string, TransformPair>;
  private chainCache = new Map<string, readonly string[]>();
  private stepCache = new Map<string, readonly TransformStep[]>();
  private compiledCache = new Map<string, TransformFunction>();

  constructor(
    transforms: Record<string, TransformPair>,
    private schemas: SchemaMap,
    private normalizer: VersionNormalizer,
    private contracts?: ContractMap,
  ) {
    this.transforms = new Map(Object.entries(transforms).map(([key, pair]) => [key, { ...pair }]));
  }

  buildChain(source: string, target: string): string[] {
    source = this.normalizer.resolveAlias(source);
    target = this.normalizer.resolveAlias(target);
    const cacheKey = JSON.stringify([source, target]);
    const cached = this.chainCache.get(cacheKey);
    if (cached) return [...cached];

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

    const chain: string[] = [];
    const step = sourceOrder < targetOrder ? 1 : -1;
    let current = source;
    for (let order = sourceOrder; order !== targetOrder; order += step) {
      const next = this.normalizer.denormalize(order + step);
      if (!next) {
        throw new TransformError(`Missing version at order ${order + step}`, 'MISSING_VERSION', {
          order: order + step,
        });
      }
      const directKey = `${current}->${next}`;
      const forwardKey = `${next}->${current}`;
      // A backward request-only pair must not hide the forward pair's response transform.
      const key =
        step > 0 || this.transforms.get(directKey)?.response
          ? directKey
          : this.transforms.has(forwardKey)
            ? forwardKey
            : directKey;
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
    this.chainCache.set(cacheKey, chain);
    return [...chain];
  }

  private getSteps(
    source: string,
    target: string,
    direction: TransformDirection,
  ): readonly TransformStep[] {
    const cacheKey = JSON.stringify([
      this.normalizer.resolveAlias(source),
      this.normalizer.resolveAlias(target),
      direction,
    ]);
    const cached = this.stepCache.get(cacheKey);
    if (cached) return cached;
    if (
      this.contracts &&
      ((direction === 'request' && this.normalizer.compare(source, target) > 0) ||
        (direction === 'response' && this.normalizer.compare(source, target) < 0))
    )
      throw new TransformError(
        'Contract requests upgrade; responses downgrade',
        'INVALID_TRANSFORM_DIRECTION',
      );
    const steps: TransformStep[] = [];
    for (const key of this.buildChain(source, target)) {
      const pair = this.transforms.get(key);
      const fn = pair?.[direction];
      if (pair && (typeof fn === 'function' || this.contracts)) {
        const [from, to] = key.split('->');
        const version = direction === 'request' ? to : from;
        steps.push({
          key,
          pair,
          fn: typeof fn === 'function' ? fn : identity,
          schema: this.contracts
            ? (this.contracts[version ?? '']?.[direction] ?? emptySchema)
            : undefined,
        });
      }
    }
    this.stepCache.set(cacheKey, steps);
    return steps;
  }

  compile(source: string, target: string, direction: TransformDirection): TransformFunction {
    const cacheKey = JSON.stringify([
      this.normalizer.resolveAlias(source),
      this.normalizer.resolveAlias(target),
      direction,
    ]);
    const cached = this.compiledCache.get(cacheKey);
    if (cached) return cached;
    const steps = this.getSteps(source, target, direction);
    const composed: TransformFunction = (input) => {
      let data = input;
      for (const { fn, schema } of steps) {
        data =
          data != null && typeof data.then === 'function'
            ? Promise.resolve(data).then(fn)
            : fn(data);
        if (schema)
          data =
            data != null && typeof data.then === 'function'
              ? Promise.resolve(data).then((value) => schema.parseAsync(value))
              : schema.parseAsync(data);
      }
      return data;
    };
    this.compiledCache.set(cacheKey, composed);
    return composed;
  }

  async execute(
    source: string,
    target: string,
    direction: TransformDirection,
    input: unknown,
    onError?: (err: TransformError) => void,
    onStep?: (step: TransformTraceStep) => void,
  ): Promise<TransformResult> {
    if (
      this.normalizer.resolveAlias(source) === this.normalizer.resolveAlias(target) &&
      this.normalizer.isValid(source)
    ) {
      return { status: 'success', data: input };
    }
    const steps = this.getSteps(source, target, direction);
    let data = input;
    let status: 'success' | 'fallback' = 'success';

    for (const { key, pair, fn, schema } of steps) {
      const stepInput = data;
      const snapshot = onStep ? structuredClone(data) : undefined;
      const started = onStep ? performance.now() : 0;
      const report = onStep
        ? (stepStatus: TransformResult['status'], error?: TransformResult['error']) => {
            const durationMs = performance.now() - started;
            onStep({
              key,
              direction,
              input: snapshot,
              output: structuredClone(data),
              status: stepStatus,
              durationMs,
              ...(error
                ? { error: { code: error.code, message: error.message, details: error.details } }
                : {}),
            });
          }
        : undefined;
      let stepError: TransformResult['error'];
      let stepStatus: 'success' | 'fallback' = 'success';
      try {
        const output = fn(data);
        data = output != null && typeof output.then === 'function' ? await output : output;
        if (schema) data = await schema.parseAsync(data);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const strategy = pair.onError;
        const error = new TransformError(
          `Transform ${key} (${direction}) failed: ${message}`,
          strategy?.strategy === 'reject'
            ? (strategy.errorCode ?? 'TRANSFORM_REJECTED')
            : schema && cause instanceof z.ZodError
              ? `${direction.toUpperCase()}_CONTRACT_FAILED`
              : 'EXECUTION_ERROR',
          {
            key,
            source,
            target,
            direction,
            originalError: message,
            ...(cause instanceof z.ZodError ? { issues: cause.issues } : {}),
          },
          { cause },
        );
        stepError = error;
        onError?.(error);
        switch (strategy?.strategy) {
          case 'log-and-continue':
            report?.('error', error);
            if (!onError) console.error(error.message);
            continue;
          case 'passthrough':
            report?.('passthrough', error);
            return { status: 'passthrough', data };
          case 'fallback':
            if (!strategy.fallback) {
              report?.('error', {
                code: 'FALLBACK_NOT_CONFIGURED',
                message: error.message,
                details: error.details,
              });
              return {
                status: 'error',
                error: {
                  code: 'FALLBACK_NOT_CONFIGURED',
                  message: error.message,
                  details: error.details,
                },
              };
            }
            try {
              data = await strategy.fallback(stepInput);
              if (schema) data = await schema.parseAsync(data);
              status = 'fallback';
              stepStatus = 'fallback';
            } catch (fallbackError) {
              const failed = {
                code: 'FALLBACK_FAILED',
                message: `Fallback for ${key} failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                details: {
                  ...error.details,
                  ...(fallbackError instanceof z.ZodError ? { issues: fallbackError.issues } : {}),
                },
              };
              report?.('error', failed);
              return { status: 'error', error: failed };
            }
            break;
          default:
            report?.('error', error);
            return {
              status: 'error',
              error: { code: error.code, message: error.message, details: error.details },
            };
        }
      }
      report?.(stepStatus, stepError);
    }
    return { status, data };
  }

  merge(endpointTransforms: Record<string, TransformPair>): TransformEngine {
    const merged = new Map(this.transforms);
    for (const [key, pair] of Object.entries(endpointTransforms)) {
      const existing = merged.get(key);
      merged.set(key, {
        request: pair.request ?? existing?.request,
        response: pair.response ?? existing?.response,
        onError: pair.onError ?? existing?.onError,
      });
    }
    return new TransformEngine(
      Object.fromEntries(merged),
      this.schemas,
      this.normalizer,
      this.contracts,
    );
  }
}
