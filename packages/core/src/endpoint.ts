import type { Pylon } from './pylon.js';
import type { EndpointConfig, PylonConfig } from './types.js';

/**
 * Deep merge two configs. Endpoint config takes precedence over global.
 *
 * Transforms are merged at the key level: endpoint transforms override
 * individual transform keys, global transforms fill in the rest.
 * Schemas are merged similarly.
 *
 * @param global - The global Pylon config
 * @param endpoint - Endpoint-specific overrides
 * @returns A new merged PylonConfig
 */
export function mergeConfigs(global: PylonConfig, endpoint: EndpointConfig): PylonConfig {
  return {
    ...global,
    endpoints: undefined,
    contracts: endpoint.contracts ?? global.contracts,
    current: endpoint.current ?? global.current,
    defaultVersion:
      endpoint.versioning === false ? (endpoint.current ?? global.current) : global.defaultVersion,
    schemas: { ...global.schemas, ...endpoint.schemas },
    transforms: endpoint.contracts
      ? (endpoint.transforms ?? {})
      : Object.fromEntries(
          Object.keys({ ...global.transforms, ...endpoint.transforms }).map((key) => [
            key,
            {
              ...global.transforms[key],
              ...endpoint.transforms?.[key],
            },
          ]),
        ),
    versioning:
      endpoint.versioning === false ? { sources: [], onMissing: 'use-default' } : global.versioning,
  };
}

/**
 * Create a Pylon instance scoped to a specific endpoint.
 *
 * Merges the global config with endpoint-specific overrides and creates
 * a new `Pylon` instance. The endpoint instance shares the same underlying
 * normalizer, detector, and engine where possible.
 *
 * @param pylon - The parent Pylon instance
 * @param _endpointName - The endpoint name (used for observability)
 * @param config - Endpoint-specific configuration overrides
 * @returns A new Pylon instance configured for the endpoint
 */
export function createEndpoint(pylon: Pylon, _endpointName: string, config: EndpointConfig): Pylon {
  return pylon.forEndpoint(_endpointName, config);
}

/**
 * Match a request path against a wildcard pattern.
 *
 * Supports two wildcard types:
 * - `*` matches a single path segment (no `/`)
 * - `**` matches zero or more path segments
 *
 * Examples:
 * - `matchEndpoint('/api/*', '/api/users')` returns `true`
 * - `matchEndpoint('/api/**', '/api/v2/users/list')` returns `true`
 * - `matchEndpoint('/api/users', '/api/posts')` returns `false`
 *
 * @param pattern - The wildcard pattern to match against
 * @param path - The actual request path
 * @returns `true` if the path matches the pattern
 */
export function matchEndpoint(pattern: string, path: string): boolean {
  // Normalize both paths by removing trailing slashes
  const normalizedPattern = pattern.replace(/\/+$/, '');
  const normalizedPath = path.replace(/\/+$/, '');

  // Escape regex special characters except * and **
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '__SINGLESTAR__');

  // Convert to regex
  let regexStr =
    '^' + escaped.replace(/__DOUBLESTAR__/g, '.*').replace(/__SINGLESTAR__/g, '[^/]*') + '$';

  // Handle ** at the end matching trailing segments
  if (normalizedPattern.endsWith('**')) {
    regexStr =
      '^' + escaped.replace(/__DOUBLESTAR__/g, '.*').replace(/__SINGLESTAR__/g, '[^/]*') + '$';
  }

  const regex = new RegExp(regexStr);
  return regex.test(normalizedPath);
}
