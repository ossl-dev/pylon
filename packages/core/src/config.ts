import { validateContracts } from './contracts.js';
import type { PylonConfig, PylonOptions, TransformPair } from './types.js';
import { VersionNormalizer } from './version-normalizer.js';

/**
 * Type-safe config helper with full inference.
 *
 * Wraps the config object to provide TypeScript type checking
 * and autocompletion. Use this as the default export of your
 * pylon config file.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   current: 'v2',
 *   schemas: { ... },
 *   transforms: { ... },
 * });
 * ```
 *
 * @param config - The Pylon configuration object
 * @returns The same config object with full type inference
 */
export function defineConfig<const C extends PylonOptions>(config: C): C & PylonConfig {
  if (config.schemas && config.transforms) return config as C & PylonConfig;
  return {
    ...config,
    schemas: config.schemas === undefined ? {} : config.schemas,
    transforms: config.transforms === undefined ? {} : config.transforms,
  } as C & PylonConfig;
}

/**
 * Validate a Pylon config at startup.
 *
 * Runs a series of checks to ensure the configuration is valid:
 * - The `current` version exists in the version definitions
 * - All schemas are valid Zod schemas
 * - Transform keys use valid version pairs
 * - The transform graph has no missing hops
 * - No circular dependencies in the transform graph
 *
 * @param config - The Pylon configuration to validate
 * @returns An object with a `valid` boolean and an array of error messages
 */
export function validateConfig(config: PylonConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate current version
  if (!config.current || typeof config.current !== 'string') {
    errors.push('Config must have a non-empty "current" version string');
  }

  // Validate schemas
  if (!config.schemas || typeof config.schemas !== 'object') {
    errors.push('Config must have a "schemas" object');
  } else {
    for (const [key, schema] of Object.entries(config.schemas)) {
      if (!schema || typeof schema !== 'object' || typeof (schema as any).parse !== 'function') {
        errors.push(`Schema "${key}" is not a valid Zod schema`);
      }
    }
  }

  // Validate transforms
  if (!config.transforms || typeof config.transforms !== 'object') {
    errors.push('Config must have a "transforms" object');
  } else {
    const transformKeys = Object.keys(config.transforms);

    for (const key of transformKeys) {
      // Validate transform key format: version->version
      const parts = key.split('->');
      if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
        errors.push(`Invalid transform key format: "${key}". Expected format: "source->target"`);
        continue;
      }

      // Check that transform has at least one function
      const pair: TransformPair | undefined = config.transforms[key];
      if (!pair) {
        errors.push(`Transform "${key}" is empty`);
        continue;
      }

      for (const direction of ['request', 'response'] as const) {
        if (
          pair[direction] !== undefined &&
          typeof pair[direction] !== 'function' &&
          pair[direction] !== 'identity'
        ) {
          errors.push(`Transform "${key}" ${direction} must be a function or 'identity'`);
        }
      }
      if (!pair.request && !pair.response) {
        errors.push(`Transform "${key}" has neither "request" nor "response" function`);
      }

      // Check for invalid error strategy
      if (pair.onError) {
        const validStrategies = ['reject', 'fallback', 'passthrough', 'log-and-continue'];
        if (!validStrategies.includes(pair.onError.strategy)) {
          errors.push(`Transform "${key}" has invalid error strategy: "${pair.onError.strategy}"`);
        }
        if (pair.onError.strategy === 'fallback' && typeof pair.onError.fallback !== 'function') {
          errors.push(
            `Transform "${key}" uses "fallback" strategy but no fallback function provided`,
          );
        }
      }
    }

    // Check for circular dependencies in request-direction transforms
    // Only request functions create request-flow edges; response-only keys
    // (v2->v1 with only response) are backward and not part of the request graph.
    const referenced = new Set<string>();
    const adj = new Map<string, Set<string>>();
    const transformMap = config.transforms ?? {};

    for (const key of transformKeys) {
      const rawParts = key.split('->').map((s) => s.trim());
      const src = rawParts[0];
      const tgt = rawParts[1];
      if (!src || !tgt) continue;
      referenced.add(src);
      referenced.add(tgt);

      // Only add to adjacency if the pair has a request function
      const pair = transformMap[key];
      if (pair?.request) {
        if (!adj.has(src)) adj.set(src, new Set());
        adj.get(src)!.add(tgt);
      }
    }

    // DFS cycle check on request-direction adjacency only
    {
      const visited = new Set<string>();
      const inStack = new Set<string>();
      const hasCycle = (node: string): boolean => {
        if (inStack.has(node)) return true;
        if (visited.has(node)) return false;
        visited.add(node);
        inStack.add(node);
        const neighbors = adj.get(node);
        if (neighbors) {
          for (const nb of neighbors) {
            if (hasCycle(nb)) return true;
          }
        }
        inStack.delete(node);
        return false;
      };
      for (const node of referenced) {
        if (hasCycle(node)) {
          errors.push(
            `Circular dependency detected in transform graph involving version "${node}"`,
          );
          break;
        }
      }
    }

    // Check current version exists
    if (
      config.current &&
      !referenced.has(config.current) &&
      !config.schemas?.[config.current] &&
      !(
        Array.isArray(config.versions) &&
        config.versions.some((v) => (typeof v === 'string' ? v : v.name) === config.current)
      ) &&
      Object.keys(config.transforms).length > 0
    ) {
      errors.push(`Current version "${config.current}" does not appear in any transform`);
    }
  }

  const unsupported = [
    [config.versioning, 'rateLimit'],
    [config.versioning?.headers, 'debug'],
    [config.observability, 'metrics'],
    [config.observability, 'logs'],
    [config.observability, 'traces'],
  ] as const;
  for (const [options, key] of unsupported) {
    if (options && Object.hasOwn(options, key))
      errors.push(`Unsupported option "${key}"; use debug.enabled or observability callbacks`);
  }
  if (
    errors.length === 0 &&
    (config.contracts || Object.values(config.endpoints ?? {}).some((e) => e.contracts))
  ) {
    try {
      const normalizer = new VersionNormalizer(config.versions, config.current);
      if (config.contracts)
        errors.push(
          ...validateContracts(
            { contracts: config.contracts, transforms: config.transforms },
            config.current,
            normalizer,
          ),
        );
      const routes = new Set<string>();
      for (const [name, endpoint] of Object.entries(config.endpoints ?? {})) {
        if (!endpoint.contracts) continue;
        if (
          !endpoint.method ||
          !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method)
        )
          errors.push(`Endpoint "${name}" requires a valid HTTP method`);
        if (!endpoint.path?.startsWith('/') || /[?#{}*]/.test(endpoint.path))
          errors.push(
            `Endpoint "${name}" requires an absolute route path with optional :name parameters`,
          );
        const parameters = (endpoint.path ?? '').split('/').filter((part) => part.startsWith(':'));
        if (
          parameters.some((part) => !/^:[A-Za-z_][\w]*$/.test(part)) ||
          new Set(parameters).size !== parameters.length
        )
          errors.push(`Endpoint "${name}" requires unique, whole-segment :name parameters`);
        for (const [version, contract] of Object.entries(endpoint.contracts)) {
          if ((endpoint.method === 'GET' || endpoint.method === 'HEAD') && contract?.request)
            errors.push(
              `Endpoint "${name}" ${version}: GET/HEAD contracts must omit request bodies`,
            );
          if (
            (endpoint.method === 'HEAD' || endpoint.status === 204 || endpoint.status === 205) &&
            contract?.response
          )
            errors.push(
              `Endpoint "${name}" ${version}: bodyless responses must omit response schemas`,
            );
        }
        const route = `${endpoint.method} ${endpoint.path?.replace(/:[A-Za-z_][\w]*/g, ':param').replace(/\/$/, '')}`;
        if (routes.has(route)) errors.push(`Duplicate endpoint route: ${route}`);
        routes.add(route);
        if (
          endpoint.status !== undefined &&
          (!Number.isInteger(endpoint.status) || endpoint.status < 200 || endpoint.status >= 300)
        )
          errors.push(`Endpoint "${name}" status must be a successful HTTP status`);
        errors.push(
          ...validateContracts(endpoint, config.current, normalizer).map(
            (error) => `Endpoint "${name}": ${error}`,
          ),
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Validate versioning config if present
  if (config.versioning) {
    if (config.versioning.sources) {
      for (const source of config.versioning.sources) {
        const validTypes = ['header', 'path', 'query', 'body'];
        if (!validTypes.includes(source.type)) {
          errors.push(
            `Invalid version source type: "${source.type}". Expected one of: ${validTypes.join(', ')}`,
          );
        }
      }
    }

    if (config.versioning.onMissing === 'use-oldest' && !config.versions) {
      errors.push('Versioning onMissing "use-oldest" requires explicit version definitions');
    }
  }

  // Validate endpoint configs if present
  if (config.endpoints) {
    for (const [name, endpoint] of Object.entries(config.endpoints)) {
      if (endpoint.schemas) {
        for (const [key, schema] of Object.entries(endpoint.schemas)) {
          if (
            !schema ||
            typeof schema !== 'object' ||
            typeof (schema as any).parse !== 'function'
          ) {
            errors.push(`Endpoint "${name}" schema "${key}" is not a valid Zod schema`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
