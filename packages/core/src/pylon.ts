import { z } from 'zod';
import { validateConfig } from './config.js';
import { routePattern } from './contracts.js';
import { mergeConfigs } from './endpoint.js';
import { TransformEngine, TransformError } from './transform-engine.js';
import type {
  DebugInfo,
  EndpointConfig,
  ProcessRequestOptions,
  PylonConfig,
  PylonOptions,
  RollbackConfig,
  RollbackStatus,
  TransformResult,
  VersionResult,
} from './types.js';
import { VersionDetectionError, VersionDetector } from './version-detector.js';
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
  private retired = new Set<string>();
  private endpointCache = new Map<string, Pylon>();
  private endpointPolicy?: EndpointConfig;
  private endpointName?: string;
  private routes: Array<{ name: string; method: string; path: RegExp; parameters: number }> = [];
  private staticRoutes = new Map<string, string>();
  /** Mutable deprecation state tracked at the Pylon instance level */
  private deprecations: Map<
    string,
    { deprecated: boolean; sunsetDate?: string; migrationGuide?: string }
  >;

  constructor(options: PylonOptions) {
    const contractMode =
      options.contracts || Object.values(options.endpoints ?? {}).some((e) => e.contracts);
    const config: PylonConfig = {
      ...options,
      schemas: options.schemas === undefined ? {} : options.schemas,
      transforms: options.transforms === undefined ? {} : options.transforms,
      versioning:
        options.versioning ??
        (contractMode ? { sources: [{ type: 'header', name: 'api-version' }] } : undefined),
    };
    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Pylon config validation failed:\n  ${validation.errors.join('\n  ')}`);
    }

    this.config = config;
    this.normalizer = new VersionNormalizer(config.versions, config.current);
    this.current = this.normalizer.resolveAlias(config.current);
    this.defaultVersion = this.normalizer.resolveAlias(config.defaultVersion ?? config.current);
    for (const version of [this.current, this.defaultVersion]) {
      if (!this.normalizer.isValid(version))
        throw new Error(`Configured version "${version}" is not in the version definitions`);
    }
    this.detector = new VersionDetector(config.versioning, this.normalizer, this.defaultVersion);
    this.engine = new TransformEngine(config.transforms, config.schemas, this.normalizer);
    this.rollbacks = new Map();
    this.unpublished = new Set();
    this.deprecations = new Map();
    for (const version of this.normalizer.listVersions()) {
      if (version.deprecated)
        this.deprecations.set(version.name, {
          deprecated: true,
          sunsetDate: version.sunsetDate,
          migrationGuide: version.migrationGuide,
        });
    }
    for (const [name, endpoint] of Object.entries(config.endpoints ?? {})) {
      if (!endpoint.contracts || !endpoint.method || !endpoint.path) continue;
      const parameters = endpoint.path.split('/').filter((part) => part.startsWith(':')).length;
      if (!parameters)
        this.staticRoutes.set(`${endpoint.method} ${endpoint.path.replace(/\/$/, '')}`, name);
      else
        this.routes.push({
          name,
          method: endpoint.method,
          path: routePattern(endpoint.path),
          parameters,
        });
      this.forEndpoint(name);
    }
    this.routes.sort((a, b) => a.parameters - b.parameters);
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
    status?: number;
    headers: Record<string, string>;
    body: unknown;
    debug?: DebugInfo;
    version: string;
    transformResult: TransformResult;
  }> {
    if (options?.endpoint && options.endpoint !== this.endpointName) {
      const scoped = this.forEndpoint(options.endpoint);
      if (scoped !== this)
        return scoped.processRequest(headers, path, query, body, {
          ...options,
          endpoint: undefined,
        });
    }
    const startTime = Date.now();

    let versionResult: VersionResult;
    try {
      versionResult =
        options?.version !== undefined
          ? { version: options.version, source: 'header' }
          : this.detectVersion(headers, path, query, body);
      if (!this.normalizer.isValid(versionResult.version)) {
        throw new VersionDetectionError(
          `Invalid API version: "${versionResult.version}"`,
          'INVALID_API_VERSION',
        );
      }
    } catch (error) {
      if (!(error instanceof VersionDetectionError)) throw error;
      return this.requestError(
        options?.version ?? this.defaultVersion,
        error.code,
        error.message,
        400,
      );
    }

    let clientVersion = this.normalizer.resolveAlias(versionResult.version);
    const minVersion = this.endpointPolicy?.minVersion;
    if (minVersion && this.normalizer.compare(clientVersion, minVersion) < 0) {
      if (this.endpointPolicy?.onOldVersion === 'use-closest') clientVersion = minVersion;
      else
        return this.requestError(
          clientVersion,
          'VERSION_TOO_OLD',
          `Endpoint requires API version "${minVersion}" or newer`,
          400,
        );
    }
    const rollback = this.getRollback(clientVersion);
    if (rollback?.mode === 'reject') {
      return this.requestError(
        clientVersion,
        'VERSION_UNPUBLISHED',
        `API version "${clientVersion}" has been unpublished. Reason: ${rollback.reason}. Use version "${rollback.fallbackVersion}" instead.`,
        410,
      );
    }
    const effectiveVersion =
      rollback?.mode === 'downgrade' ? rollback.fallbackVersion : clientVersion;

    if (this.config.contracts) {
      const contract = this.config.contracts[effectiveVersion];
      if (!contract)
        return this.requestError(
          clientVersion,
          'UNSUPPORTED_ENDPOINT_VERSION',
          `Endpoint has no contract for version "${effectiveVersion}"`,
          400,
        );
      try {
        const parsed = await (contract.request ?? z.undefined()).safeParseAsync(body);
        if (!parsed.success)
          return this.requestError(
            clientVersion,
            'VALIDATION_ERROR',
            'Request body validation failed',
            422,
            { issues: parsed.error.issues },
          );
        body = parsed.data;
      } catch (error) {
        return this.requestError(
          clientVersion,
          'VALIDATION_FAILED',
          error instanceof Error ? error.message : String(error),
          500,
        );
      }
    }

    // 2. Transform request to current version
    let transformsApplied: string[] = [];
    let transformResult: TransformResult = { status: 'success', data: body };
    let transformedBody = body;

    if (effectiveVersion !== this.current) {
      try {
        transformResult = await this.engine.execute(
          effectiveVersion,
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

        if (transformResult.status !== 'error') transformedBody = transformResult.data;

        if (this.config.debug?.enabled)
          transformsApplied = this.engine.buildChain(effectiveVersion, this.current);
      } catch (error) {
        return this.requestError(
          clientVersion,
          'TRANSFORM_FAILED',
          error instanceof Error ? error.message : String(error),
          500,
        );
      }
    }

    if (transformResult.status === 'error') {
      return this.requestError(
        clientVersion,
        transformResult.error?.code ?? 'TRANSFORM_FAILED',
        transformResult.error?.message ?? 'Request transformation failed',
        500,
        transformResult.error?.details,
      );
    }

    // 3. Validate against current version's schema
    const schema = this.config.contracts
      ? (this.config.contracts[this.current]?.request ?? z.undefined())
      : this.config.schemas[this.current];
    if (schema && (!this.config.contracts || effectiveVersion !== this.current)) {
      try {
        const parsed = await schema.parseAsync(transformedBody);
        transformedBody = parsed;
      } catch (err: any) {
        if (err instanceof z.ZodError) {
          if (this.config.contracts)
            return this.requestError(
              clientVersion,
              'REQUEST_CONTRACT_FAILED',
              'Request migration produced an invalid current contract',
              500,
              { issues: err.issues },
            );
          return {
            status: 422,
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

    transformResult = { ...transformResult, data: transformedBody };

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

    const debug = this.config.debug?.enabled
      ? this.buildDebugInfo({
          clientVersion,
          currentVersion: this.current,
          transformsApplied,
          originalRequest: body,
          transformedRequest: transformedBody,
          startTime,
        })
      : undefined;

    return {
      headers: responseHeaders,
      body: transformedBody,
      version: clientVersion,
      transformResult,
      debug: this.config.debug?.enabled ? debug : undefined,
    };
  }

  private requestError(
    version: string,
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    const error = { code, message, ...(details ? { details } : {}) };
    return {
      status,
      headers: {
        'content-type': 'application/json',
        ...this.generateResponseHeaders(version, this.current),
      },
      body: { error },
      version,
      transformResult: { status: 'error' as const, error },
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
    status = 200,
  ): Promise<{
    status?: number;
    headers: Record<string, string>;
    body: unknown;
    debug?: DebugInfo;
  }> {
    const startTime = Date.now();

    if (!this.needsResponseProcessing(clientVersion, status))
      return { headers: responseHeaders, body: responseBody, debug };

    clientVersion = this.normalizer.resolveAlias(clientVersion);
    const rollback = this.getRollback(clientVersion);
    const targetVersion = rollback?.mode === 'downgrade' ? rollback.fallbackVersion : clientVersion;
    if (!this.config.contracts && (!clientVersion || targetVersion === this.current)) {
      return {
        headers: responseHeaders,
        body: responseBody,
        debug,
      };
    }

    let transformedBody = responseBody;

    try {
      if (this.config.contracts)
        transformedBody = await (
          this.config.contracts[this.current]?.response ?? z.undefined()
        ).parseAsync(transformedBody);
      const result = await this.engine.execute(
        this.current,
        targetVersion,
        'response',
        transformedBody,
        (err) =>
          this.config.onTransformError?.({
            source: this.current,
            target: clientVersion,
            direction: 'response',
            originalError: err instanceof Error ? err : new Error(String(err)),
          }),
      );

      if (result.status === 'error') {
        throw new TransformError(
          result.error?.message ?? 'Response transformation failed',
          result.error?.code ?? 'RESPONSE_TRANSFORM_FAILED',
          result.error?.details,
        );
      }
      transformedBody = result.data;
      if (this.config.contracts && targetVersion !== this.current) {
        const contract = this.config.contracts[targetVersion];
        if (!contract)
          throw new Error(`Endpoint has no response contract for version "${targetVersion}"`);
        transformedBody = await (contract.response ?? z.undefined()).parseAsync(transformedBody);
      }
    } catch (err: any) {
      this.config.observability?.onError?.({
        source: this.current,
        target: clientVersion,
        direction: 'response',
        originalError: err instanceof Error ? err : new Error(String(err)),
      });

      return {
        status: 500,
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

    const updatedDebug = this.config.debug?.enabled
      ? this.buildDebugInfo({
          clientVersion,
          currentVersion: this.current,
          transformsApplied: [...transformsApplied].reverse(),
          originalResponse: responseBody,
          transformedResponse: transformedBody,
          startTime,
        })
      : undefined;

    return {
      headers: {
        ...responseHeaders,
        ...this.generateResponseHeaders(clientVersion, this.current),
      },
      body: transformedBody,
      debug: this.config.debug?.enabled ? updatedDebug : undefined,
    };
  }

  /** Errors and bodyless responses pass through. Current contracts still validate handler output. */
  needsResponseProcessing(version: string, status = 200): boolean {
    if (status < 200 || status >= 300 || status === 204 || status === 205) return false;
    const canonical = this.normalizer.resolveAlias(version);
    const target =
      this.getRollback(canonical)?.mode === 'downgrade'
        ? this.getRollback(canonical)!.fallbackVersion
        : canonical;
    return Boolean(this.config.contracts) || target !== this.current;
  }

  forRoute(method: string, path: string): Pylon {
    const pathname = path.split('?')[0] ?? path;
    const exact = this.staticRoutes.get(`${method} ${pathname.replace(/\/$/, '')}`);
    if (exact) return this.forEndpoint(exact);
    const route = this.routes.find((route) => route.method === method && route.path.test(pathname));
    return route ? this.forEndpoint(route.name) : this;
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
    if (this.retired.has(resolved))
      throw new Error(`Cannot publish permanently retired version: "${version}"`);
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

    this.retired.add(resolved);

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
  forEndpoint(endpoint: string, config?: EndpointConfig): Pylon {
    if (endpoint === this.endpointName && !config) return this;
    const cached = this.endpointCache.get(endpoint);
    if (cached && !config) return cached;
    const endpointConfig =
      config ??
      (Object.hasOwn(this.config.endpoints ?? {}, endpoint)
        ? this.config.endpoints?.[endpoint]
        : undefined);
    if (!endpointConfig) {
      throw new Error(`Unknown Pylon endpoint: "${endpoint}"`);
    }

    const merged = mergeConfigs(this.config, endpointConfig);
    const scoped = new Pylon(merged);
    scoped.endpointName = endpoint;
    const minimum =
      endpointConfig.minVersion ??
      (endpointConfig.contracts
        ? this.normalizer
            .listVersions()
            .find((v) => Object.hasOwn(endpointConfig.contracts!, v.name))?.name
        : undefined);
    scoped.endpointPolicy = { ...endpointConfig, minVersion: minimum };
    scoped.rollbacks = this.rollbacks;
    scoped.unpublished = this.unpublished;
    scoped.retired = this.retired;
    scoped.deprecations = this.deprecations;
    if (!config) this.endpointCache.set(endpoint, scoped);
    return scoped;
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
