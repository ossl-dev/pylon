import type { VersioningConfig, VersionResult, VersionSource } from './types.js';
import type { VersionNormalizer } from './version-normalizer.js';

const DEFAULT_SOURCES: VersionSource[] = [
  { type: 'header', name: 'accept-version' },
  { type: 'header', name: 'api-version' },
  { type: 'path', pattern: /\/(v\d+)\/?/ },
  { type: 'query', name: 'api_version' },
  { type: 'query', name: 'version' },
  { type: 'body', name: 'version' },
];

/**
 * Detects the API version from incoming request components.
 *
 * Checks sources in order: header, path, query, body.
 * Supports version negotiation for the `Accept-Version` header
 * where a client can send multiple supported versions.
 */
export class VersionDetector {
  private sources: VersionSource[];
  private onMissing: 'use-default' | 'reject' | 'use-oldest';
  private onInvalid: 'reject' | 'use-default';
  private defaultVersion: string;
  private normalizer: VersionNormalizer;
  private negotiation?: VersioningConfig['negotiation'];

  constructor(
    config: VersioningConfig | undefined,
    normalizer: VersionNormalizer,
    defaultVersion: string,
  ) {
    this.sources = config?.sources ?? DEFAULT_SOURCES;
    this.onMissing = config?.onMissing ?? 'use-default';
    this.onInvalid = config?.onInvalid ?? 'reject';
    this.defaultVersion = defaultVersion;
    this.normalizer = normalizer;
    this.negotiation = config?.negotiation;
  }

  /**
   * Detect the API version from request components.
   *
   * Checks sources in order (header, path, query, body) and returns the
   * first valid version found. Falls back to the default version if none
   * is found and `onMissing` is set to `'use-default'`.
   *
   * @param headers - Request headers (lowercased)
   * @param path - URL path
   * @param query - Query parameters
   * @param body - Optional parsed request body
   * @returns The detected version result
   */
  detect(
    headers: Record<string, string>,
    path: string,
    query: Record<string, string>,
    body?: Record<string, unknown>,
  ): VersionResult {
    // Try each source in order
    const headerResult = this.checkHeaders(headers);
    if (headerResult) return headerResult;

    const pathResult = this.checkPath(path);
    if (pathResult) return pathResult;

    const queryResult = this.checkQuery(query);
    if (queryResult) return queryResult;

    const bodyResult = this.checkBody(body);
    if (bodyResult) return bodyResult;

    // No version found — apply missing strategy
    if (this.onMissing === 'reject') {
      throw new Error('No API version found in request');
    }

    if (this.onMissing === 'use-oldest') {
      const versions = this.normalizer.listVersions();
      if (versions.length > 0) {
        const first = versions[0];
        if (first) {
          return { version: first.name, source: 'default' };
        }
      }
      return { version: this.defaultVersion, source: 'default' };
    }

    return { version: this.defaultVersion, source: 'default' };
  }

  /**
   * Check header sources for a version indicator.
   *
   * Supports the `Accept-Version` header with negotiation (e.g.,
   * `Accept-Version: v2, v3` picks the highest supported version).
   * Also checks `Api-Version` and any custom header names.
   */
  private checkHeaders(headers: Record<string, string>): VersionResult | null {
    const headerSources = this.sources.filter((s) => s.type === 'header');

    for (const source of headerSources) {
      const headerName = source.name?.toLowerCase() ?? '';
      if (!headerName) continue;

      const headerValue = headers[headerName];
      if (!headerValue) continue;

      const trimmed = headerValue.trim();
      if (!trimmed) continue;

      // Check if this is a comma-separated list (negotiation)
      if (trimmed.includes(',')) {
        const versions = trimmed
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        if (versions.length > 1) {
          const negotiated = this.negotiate(versions);
          return { version: negotiated, source: 'header', headerName };
        }
      }

      // Single version value
      if (this.onInvalid === 'reject' && !this.normalizer.isValid(trimmed)) {
        throw new Error(`Invalid API version specified in header "${headerName}": "${trimmed}"`);
      }

      if (this.onInvalid === 'use-default' && !this.normalizer.isValid(trimmed)) {
        return { version: this.defaultVersion, source: 'header', headerName };
      }

      return { version: trimmed, source: 'header', headerName };
    }

    return null;
  }

  /**
   * Check the URL path for a version pattern like `/v2/users`.
   *
   * Uses the first configured path source's pattern, or the default
   * pattern `/\/(v\d+)\/?/`.
   */
  private checkPath(path: string): VersionResult | null {
    const pathSources = this.sources.filter((s) => s.type === 'path');

    for (const source of pathSources) {
      const pattern = source.pattern ?? /\/(v\d+)\/?/;
      const match = path.match(pattern);
      if (match && match[1]) {
        const version = match[1];

        if (this.onInvalid === 'reject' && !this.normalizer.isValid(version)) {
          throw new Error(`Invalid API version in path: "${version}"`);
        }

        if (this.onInvalid === 'use-default' && !this.normalizer.isValid(version)) {
          return { version: this.defaultVersion, source: 'path' };
        }

        return { version, source: 'path' };
      }
    }

    return null;
  }

  /**
   * Check query parameters for a version indicator like `?api_version=v2`.
   */
  private checkQuery(query: Record<string, string>): VersionResult | null {
    const querySources = this.sources.filter((s) => s.type === 'query');

    for (const source of querySources) {
      const paramName = source.name ?? 'api_version';
      const value = query[paramName];
      if (!value) continue;

      const trimmed = value.trim();
      if (!trimmed) continue;

      if (this.onInvalid === 'reject' && !this.normalizer.isValid(trimmed)) {
        throw new Error(`Invalid API version in query parameter "${paramName}": "${trimmed}"`);
      }

      if (this.onInvalid === 'use-default' && !this.normalizer.isValid(trimmed)) {
        return { version: this.defaultVersion, source: 'query' };
      }

      return { version: trimmed, source: 'query' };
    }

    return null;
  }

  /**
   * Check the request body for a version field.
   */
  private checkBody(body?: Record<string, unknown>): VersionResult | null {
    if (!body || typeof body !== 'object') return null;

    const bodySources = this.sources.filter((s) => s.type === 'body');

    for (const source of bodySources) {
      const fieldName = source.name ?? 'version';
      const value = body[fieldName];

      if (!value || typeof value !== 'string') continue;

      const trimmed = value.trim();
      if (!trimmed) continue;

      if (this.onInvalid === 'reject' && !this.normalizer.isValid(trimmed)) {
        throw new Error(`Invalid API version in body field "${fieldName}": "${trimmed}"`);
      }

      if (this.onInvalid === 'use-default' && !this.normalizer.isValid(trimmed)) {
        return { version: this.defaultVersion, source: 'body' };
      }

      return { version: trimmed, source: 'body' };
    }

    return null;
  }

  /**
   * Negotiate a version when the client sends multiple supported versions.
   *
   * Used with headers like `Accept-Version: v2, v3` where the strategy
   * determines which version to pick.
   *
   * @param versions - List of version strings from the client
   * @returns The negotiated version string
   */
  private negotiate(versions: string[]): string {
    const strategy = this.negotiation?.strategy ?? 'highest-supported';

    switch (strategy) {
      case 'highest-supported': {
        // Find the highest version that we support
        const supported = versions.filter((v) => this.normalizer.isValid(v));
        if (supported.length === 0) {
          if (this.negotiation?.onUnsupported === 'reject') {
            throw new Error(`No supported API version found in: ${versions.join(', ')}`);
          }
          if (this.negotiation?.onUnsupported === 'use-closest') {
            // Find the closest version we support
            return this.defaultVersion;
          }
          return this.defaultVersion;
        }
        const sorted = this.normalizer.sort(supported);
        return sorted[sorted.length - 1]!;
      }
      case 'exact': {
        // All versions must be supported, pick the first client prefers
        for (const v of versions) {
          if (this.normalizer.isValid(v)) return v;
        }
        if (this.negotiation?.onUnsupported === 'reject') {
          throw new Error(`No supported API version found in: ${versions.join(', ')}`);
        }
        return this.defaultVersion;
      }
      case 'closest': {
        const valid = versions.filter((v) => this.normalizer.isValid(v));
        if (valid.length === 0) {
          if (this.negotiation?.onUnsupported === 'reject') {
            throw new Error(`No supported API version found in: ${versions.join(', ')}`);
          }
          return this.defaultVersion;
        }
        // Return the closest supported version (prefer client's first choice)
        return valid[0]!;
      }
      default:
        return this.defaultVersion;
    }
  }
}
