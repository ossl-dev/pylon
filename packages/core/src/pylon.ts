import { z } from 'zod';
import { validateConfig } from './config.js';
import { TransformEngine } from './transform-engine.js';
import type {
  DebugInfo,
  EndpointConfig,
  ProcessRequestOptions,
  PylonConfig,
  RollbackConfig,
  RollbackStatus,
  TransformResult,
  VersionResult,
} from './types.js';
import { VersionDetector } from './version-detector.js';
import { VersionNormalizer } from './version-normalizer.js';

/**
 * The main Pylon class for API versioning.
 *
 * Orchestrates version detection, request/response transformation, schema
 * validation, version rollback, and response header generation. Use this
 * as the entry point for integrating API versioning into your framework.
 *
 * @example
 * ```ts
 * const pylon = new Pylon({
 *   current: 'v2',
 *   schemas: { v1: schemaV1, v2: schemaV2 },
 *   transforms: { 'v1->v2': { request: transformV1toV2 } },
 * });
 * ```
 */
export class Pylon {
  readonly config: PylonConfig;
  readonly current: string;
  readonly defaultVersion: string;
  readonly normalizer: VersionNormalizer;
  readonly detector: VersionDetector;
  readonly engine: TransformEngine;
  private rollbacks: Map<string, RollbackStatus>;
  private unpublished: Set<string>;
  /** Mutable deprecation state tracked at the Pylon instance level */
  private deprecations: Map<
    string,
    { deprecated: boolean; sunsetDate?: string; migrationGuide?: string }
  >;

  constructor(config: PylonConfig) {
    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Pylon config validation failed:\n  ${validation.errors.join('\n  ')}`);
    }

    this.config = config;
    this.current = config.current;
    this.defaultVersion = config.defaultVersion ?? config.current;
    this.normalizer = new VersionNormalizer(config.versions, config.current);
    this.detector = new VersionDetector(config.versioning, this.normalizer, this.defaultVersion);
    this.engine = new TransformEngine(config.transforms, config.schemas, this.normalizer);
    this.rollbacks = new Map();
    this.unpublished = new Set();
    this.deprecations = new Map();
  }

  /**
   * Main request processing pipeline.
   *
   * Steps:
   * 1. Detect the client's API version
   * 2. Transform the request body from the client version to the current version
   * 3. Validate the transformed body against the current version's schema
   *
   * The transformed request body is returned so the controller can process it.
   * Response transformation back to the client version is handled by
   * {@link processResponse}.
   *
   * @param headers - Request headers
   * @param path - Request URL path
   * @param query - Request query parameters
   * @param body - Optional request body
   * @param options - Optional processing options (endpoint, version override)
   * @returns An object with response headers, the transformed body, version info, and debug info
   */
  async processRequest(
    headers: Record<string, string>,
    path: string,
    query: Record<string, string>,
    body?: unknown,
    options?: ProcessRequestOptions,
  ): Promise<{
    headers: Record<string, string>;
    body: unknown;
    debug?: DebugInfo;
    version: string;
    transformResult: TransformResult;
  }> {
    const startTime = Date.now();

    // 1. Detect version
    let versionResult: VersionResult;
    try {
      versionResult = options?.version
        ? { version: options.version, source: 'header' as const }
        : this.detectVersion(headers, path, query, body as Record<string, unknown>);
    } catch {
      // If version detection fails entirely, use default
      versionResult = { version: this.defaultVersion, source: 'default' };
    }

    const clientVersion = versionResult.version;

    // Check if version is unpublished (rolled back)
    if (this.isUnpublished(clientVersion)) {
      const rollback = this.getRollback(clientVersion);
      if (rollback && rollback.mode === 'reject') {
        return {
          headers: {
            'content-type': 'application/json',
            ...this.generateResponseHeaders(clientVersion, this.current),
          },
          body: {
            error: {
              code: 'VERSION_UNPUBLISHED',
              message: `API version "${clientVersion}" has been unpublished. Reason: ${rollback.reason}. Use version "${rollback.fallbackVersion}" instead.`,
            },
          },
          version: clientVersion,
          transformResult: {
            status: 'error',
            error: {
              code: 'VERSION_UNPUBLISHED',
              message: rollback.reason,
            },
          },
        };
      }

      // For 'downgrade' and 'shadow' modes, continue but use fallback version
      if (rollback && rollback.mode === 'downgrade') {
        const transformsApplied: string[] = [];
        let transformResult: TransformResult = { status: 'success', data: body };
        let transformedBody = body;

        if (rollback.fallbackVersion !== this.current) {
          try {
            transformResult = await this.engine.execute(
              rollback.fallbackVersion,
              this.current,
              'request',
              body,
              (err) =>
                this.config.onTransformError?.({
                  source: rollback.fallbackVersion,
                  target: this.current,
                  direction: 'request',
                  originalError: err instanceof Error ? err : new Error(String(err)),
                  endpoint: options?.endpoint,
                }),
            );

            if (transformResult.data !== undefined) {
              transformedBody = transformResult.data;
            }
            transformsApplied.push(`${rollback.fallbackVersion}->${this.current}`);
          } catch (err: any) {
            return {
              headers: {
                'content-type': 'application/json',
                ...this.generateResponseHeaders(clientVersion, this.current),
              },
              body: {
                error: {
                  code: 'TRANSFORM_FAILED',
                  message: `Failed to transform request from "${rollback.fallbackVersion}" to "${this.current}": ${err.message}`,
                },
              },
              version: clientVersion,
              transformResult: {
                status: 'error',
                error: {
                  code: 'TRANSFORM_FAILED',
                  message: err.message,
                },
              },
            };
          }
        }

        const responseHeaders = this.generateResponseHeaders(clientVersion, this.current);

        // Observability hook
        const durationMs = Date.now() - startTime;
        this.config.observability?.onTransform?.({
          source: clientVersion,
          target: this.current,
          direction: 'request',
          durationMs,
          endpoint: options?.endpoint,
        });

        const debug = this.buildDebugInfo({
          clientVersion,
          currentVersion: this.current,
          transformsApplied,
          startTime,
        });

        return {
          headers: responseHeaders,
          body: transformedBody,
          version: clientVersion,
          transformResult,
          debug: this.config.debug?.enabled ? debug : undefined,
        };
      }
    }

    // 2. Transform request to current version
    let transformsApplied: string[] = [];
    let transformResult: TransformResult = { status: 'success', data: body };
    let transformedBody = body;

    if (clientVersion !== this.current) {
      try {
        transformResult = await this.engine.execute(
          clientVersion,
          this.current,
          'request',
          body,
          (err) =>
            this.config.onTransformError?.({
              source: clientVersion,
              target: this.current,
              direction: 'request',
              originalError: err instanceof Error ? err : new Error(String(err)),
              endpoint: options?.endpoint,
            }),
        );

        if (transformResult.data !== undefined) {
          transformedBody = transformResult.data;
        }

        try {
          transformsApplied = this.engine.buildChain(clientVersion, this.current);
        } catch {
          // Chain building is best-effort for debug purposes
        }
      } catch (err: any) {
        return {
          headers: {
            'content-type': 'application/json',
            ...this.generateResponseHeaders(clientVersion, this.current),
          },
          body: {
            error: {
              code: 'TRANSFORM_FAILED',
              message: `Failed to transform request from "${clientVersion}" to "${this.current}": ${err.message}`,
            },
          },
          version: clientVersion,
          transformResult: {
            status: 'error',
            error: {
              code: 'TRANSFORM_FAILED',
              message: err.message,
            },
          },
        };
      }
    }

    // 3. Validate against current version's schema
    const schema = this.config.schemas[this.current];
    if (schema) {
      try {
        const parsed = schema.parse(transformedBody);
        transformedBody = parsed;
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          return {
            headers: {
              'content-type': 'application/json',
              ...this.generateResponseHeaders(clientVersion, this.current),
            },
            body: {
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Request body validation failed',
                details: err.issues,
              },
            },
            version: clientVersion,
            transformResult: {
              status: 'error',
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Request body validation failed',
                details: err.issues,
              },
            },
          };
        }
        throw err;
      }
    }

    // Generate response headers
    const responseHeaders = this.generateResponseHeaders(clientVersion, this.current);

    // Observability hook
    const durationMs = Date.now() - startTime;
    this.config.observability?.onTransform?.({
      source: clientVersion,
      target: this.current,
      direction: 'request',
      durationMs,
      endpoint: options?.endpoint,
    });

    const debug = this.buildDebugInfo({
      clientVersion,
      currentVersion: this.current,
      transformsApplied,
      originalRequest: body,
      transformedRequest: transformedBody,
      startTime,
    });

    return {
      headers: responseHeaders,
      body: transformedBody,
      version: clientVersion,
      transformResult,
      debug: this.config.debug?.enabled ? debug : undefined,
    };
  }

  /**
   * Transform a response back to the client's API version.
   *
   * Call this after your controller has processed the request and generated
   * a response body. The response is transformed from the current version
   * back to the original client version.
   *
   * @param clientVersion - The client's original API version
   * @param responseBody - The response body from the controller
   * @param responseHeaders - Headers from the controller
   * @param transformsApplied - Array of transform keys that were applied (from processRequest)
   * @param debug - Optional debug info from processRequest to augment
   * @returns An object with response headers and the transformed body
   */
  async processResponse(
    clientVersion: string,
    responseBody: unknown,
    responseHeaders: Record<string, string>,
    transformsApplied: string[],
    debug?: DebugInfo,
  ): Promise<{
    headers: Record<string, string>;
    body: unknown;
    debug?: DebugInfo;
  }> {
    const startTime = Date.now();

    if (!clientVersion || clientVersion === this.current) {
      return {
        headers: responseHeaders,
        body: responseBody,
        debug,
      };
    }

    let transformedBody = responseBody;

    try {
      const result = await this.engine.execute(
        this.current,
        clientVersion,
        'response',
        responseBody,
        (err) =>
          this.config.onTransformError?.({
            source: this.current,
            target: clientVersion,
            direction: 'response',
            originalError: err instanceof Error ? err : new Error(String(err)),
          }),
      );

      if (result.data !== undefined) {
        transformedBody = result.data;
      }
    } catch (err: any) {
      this.config.observability?.onError?.({
        source: this.current,
        target: clientVersion,
        direction: 'response',
        originalError: err instanceof Error ? err : new Error(String(err)),
      });

      return {
        headers: {
          ...responseHeaders,
          'content-type': 'application/json',
        },
        body: {
          error: {
            code: 'RESPONSE_TRANSFORM_FAILED',
            message: `Failed to transform response from "${this.current}" to "${clientVersion}": ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        debug,
      };
    }

    const updatedDebug = this.buildDebugInfo({
      clientVersion,
      currentVersion: this.current,
      transformsApplied: [...transformsApplied].reverse(),
      originalResponse: responseBody,
      transformedResponse: transformedBody,
      startTime,
    });

    return {
      headers: {
        ...responseHeaders,
        ...this.generateResponseHeaders(clientVersion, this.current),
      },
      body: transformedBody,
      debug: this.config.debug?.enabled ? updatedDebug : undefined,
    };
  }

  /**
   * Detect the API version from request components.
   *
   * Delegates to the {@link VersionDetector}. Checks headers, path,
   * query parameters, and body in order.
   *
   * @param headers - Request headers
   * @param path - Request URL path
   * @param query - Request query parameters
   * @param body - Optional request body
   * @returns The detected version result
   */
  detectVersion(
    headers: Record<string, string>,
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ): VersionResult {
    return this.detector.detect(headers, path, query, body as Record<string, unknown>);
  }

  /**
   * Transform data between two API versions.
   *
   * @param source - Source version string
   * @param target - Target version string
   * @param direction - Transform direction (`'request'` or `'response'`)
   * @param data - The data to transform
   * @returns The transform result
   */
  async transform(
    source: string,
    target: string,
    direction: 'request' | 'response',
    data: unknown,
  ): Promise<TransformResult> {
    return this.engine.execute(source, target, direction, data);
  }

  /**
   * Validate data against the schema for a given version.
   *
   * @param data - The data to validate
   * @param version - The version whose schema to validate against
   * @returns An object with `success` flag and optional `errors`
   */
  validate(data: unknown, version: string): { success: boolean; errors?: z.ZodError } {
    const schema = this.config.schemas[version];
    if (!schema) {
      return { success: true };
    }

    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true };
    }

    return { success: false, errors: result.error };
  }

  /**
   * Emergency unpublish a version and roll back to a fallback.
   *
   * All rollback state is in-memory — no deploy needed. The rollback
   * can operate in three modes:
   * - `'downgrade'`: transparently downgrade requests to the fallback version
   * - `'reject'`: reject all requests to the unpublished version
   * - `'shadow'`: process with the fallback but return original version responses
   *
   * @param version - The version to unpublish
   * @param config - Rollback configuration
   */
  async rollback(version: string, config: RollbackConfig): Promise<void> {
    if (!this.normalizer.isValid(version)) {
      throw new Error(`Cannot rollback unknown version: "${version}"`);
    }

    if (!this.normalizer.isValid(config.fallback)) {
      throw new Error(`Cannot rollback to unknown fallback version: "${config.fallback}"`);
    }

    const resolvedVersion = this.normalizer.resolveAlias(version);
    const mode = config.mode ?? 'downgrade';

    this.unpublished.add(resolvedVersion);

    this.rollbacks.set(resolvedVersion, {
      unpublishedVersion: resolvedVersion,
      fallbackVersion: config.fallback,
      timestamp: new Date(),
      reason: config.reason,
      mode,
      active: true,
    });
  }

  /**
   * Re-publish a previously rolled-back version.
   *
   * @param version - The version to re-publish
   */
  async publish(version: string): Promise<void> {
    const resolved = this.normalizer.resolveAlias(version);
    this.unpublished.delete(resolved);
    this.rollbacks.delete(resolved);
  }

  /**
   * Permanently retire a version.
   *
   * Once retired, the version cannot be re-published. Retired versions
   * remain in the version list but are marked with a sunset date and
   * optional migration guide.
   *
   * @param version - The version to retire
   * @param config - Retirement configuration
   */
  async retire(
    version: string,
    config: { sunsetDate?: string; migrationGuide?: string },
  ): Promise<void> {
    const resolved = this.normalizer.resolveAlias(version);
    if (!this.normalizer.isValid(resolved)) {
      throw new Error(`Cannot retire unknown version: "${version}"`);
    }

    this.unpublished.add(resolved);
    this.rollbacks.set(resolved, {
      unpublishedVersion: resolved,
      fallbackVersion: this.current,
      timestamp: new Date(),
      reason: 'Version permanently retired',
      mode: 'reject',
      active: true,
    });

    // Mark as deprecated as well
    this.deprecate(resolved, config);
  }

  /**
   * Mark a version as deprecated.
   *
   * Deprecated versions still work but will have deprecation headers
   * added to responses. The optional `sunsetDate` and `migrationGuide`
   * inform clients about the deprecation timeline.
   *
   * @param version - The version to deprecate
   * @param config - Optional deprecation configuration
   */
  deprecate(version: string, config?: { sunsetDate?: string; migrationGuide?: string }): void {
    const resolved = this.normalizer.resolveAlias(version);
    this.deprecations.set(resolved, {
      deprecated: true,
      sunsetDate: config?.sunsetDate,
      migrationGuide: config?.migrationGuide,
    });
  }

  /**
   * Check if a version is deprecated.
   *
   * @param version - The version to check
   * @returns `true` if the version has been marked as deprecated
   */
  isDeprecated(version: string): boolean {
    const resolved = this.normalizer.resolveAlias(version);
    return this.deprecations.get(resolved)?.deprecated === true;
  }

  /**
   * Generate response headers for API versioning.
   *
   * Includes:
   * - `X-API-Version`: The current (latest) API version
   * - `Deprecation`: If the client version is deprecated (RFC 8594)
   * - `Sunset`: If a sunset date is configured for the client version
   * - `Link`: Migration guide link if available
   *
   * @param clientVersion - The client's API version
   * @param currentVersion - The current (latest) API version
   * @returns Response headers object
   */
  private generateResponseHeaders(
    clientVersion: string,
    currentVersion: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    const headerConfig = this.config.versioning?.headers;

    // X-API-Version
    if (headerConfig?.apiVersion !== false) {
      headers['X-API-Version'] = currentVersion;
    }

    // Deprecation header for deprecated versions
    const resolvedClient = this.normalizer.resolveAlias(clientVersion);
    const dep = this.deprecations.get(resolvedClient);

    if (dep?.deprecated && headerConfig?.deprecation !== false) {
      headers['Deprecation'] = 'true';

      if (dep.sunsetDate) {
        headers['Sunset'] = dep.sunsetDate;
      }

      if (dep.migrationGuide) {
        headers['Link'] = `<${dep.migrationGuide}>; rel="sunset"`;
      }
    }

    // Debug header
    if (this.config.debug?.enabled) {
      const debugHeader = this.config.debug.header ?? 'X-Pylon-Debug';
      headers[debugHeader] = 'enabled';
    }

    return headers;
  }

  /**
   * Build debug information for the request/response lifecycle.
   *
   * @param info - Debug info components
   * @returns DebugInfo object
   */
  private buildDebugInfo(info: {
    clientVersion: string;
    currentVersion: string;
    transformsApplied: string[];
    originalRequest?: unknown;
    transformedRequest?: unknown;
    originalResponse?: unknown;
    transformedResponse?: unknown;
    startTime: number;
  }): DebugInfo {
    return {
      clientVersion: info.clientVersion,
      currentVersion: info.currentVersion,
      transformsApplied: info.transformsApplied,
      originalRequest: info.originalRequest,
      transformedRequest: info.transformedRequest,
      originalResponse: info.originalResponse,
      transformedResponse: info.transformedResponse,
      durationMs: Date.now() - info.startTime,
    };
  }

  /**
   * Create a new Pylon instance scoped to a specific endpoint.
   *
   * The endpoint instance inherits the global configuration but merges
   * any endpoint-specific overrides. Endpoint config is looked up from
   * the `endpoints` field in the Pylon config.
   *
   * @param endpoint - The endpoint name to scope to
   * @returns A new Pylon instance for the endpoint
   */
  forEndpoint(endpoint: string): Pylon {
    const endpointConfig = this.config.endpoints?.[endpoint];
    if (!endpointConfig) {
      return this;
    }

    const merged = this.mergeEndpointConfig(this.config, endpointConfig);
    return new Pylon(merged);
  }

  /**
   * Merge endpoint config with global config.
   *
   * Endpoint-specific transforms and schemas override global ones at the key level.
   * Avoids circular dependency with endpoint.ts by inlining the merge logic.
   */
  private mergeEndpointConfig(global: PylonConfig, endpoint: EndpointConfig): PylonConfig {
    return {
      ...global,
      current: endpoint.current ?? global.current,
      schemas: {
        ...(global.schemas ?? {}),
        ...(endpoint.schemas ?? {}),
      },
      transforms: {
        ...(global.transforms ?? {}),
        ...(endpoint.transforms ?? {}),
      },
      versioning: endpoint.versioning === false ? undefined : global.versioning,
      ...(endpoint.minVersion
        ? {
            versioning: {
              ...(global.versioning ?? { sources: [] }),
            },
          }
        : {}),
    };
  }

  /**
   * Get the inferred TypeScript type for a version's schema.
   *
   * This is a type-level helper — at runtime it simply returns `undefined`.
   * Use it to extract the input type from a version's Zod schema.
   *
   * @example
   * ```ts
   * type V1Input = typeof pylon.infer<'v1'>;
   * ```
   *
   * @param _version - The version string
   * @returns The inferred type (undefined at runtime)
   */
  infer<T = any>(_version: string): T {
    return undefined as unknown as T;
  }

  /**
   * Check if a version has been unpublished (rolled back).
   *
   * @param version - The version to check
   * @returns `true` if the version is unpublished
   */
  isUnpublished(version: string): boolean {
    const resolved = this.normalizer.resolveAlias(version);
    return this.unpublished.has(resolved);
  }

  /**
   * Get the active rollback status for a version, if any.
   *
   * @param version - The version to check
   * @returns The rollback status, or `undefined` if not rolled back
   */
  getRollback(version: string): RollbackStatus | undefined {
    const resolved = this.normalizer.resolveAlias(version);
    return this.rollbacks.get(resolved);
  }
}
