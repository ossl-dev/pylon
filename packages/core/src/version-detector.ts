import type { VersioningConfig, VersionResult, VersionSource } from './types.js';
import type { VersionNormalizer } from './version-normalizer.js';

const DEFAULT_SOURCES: VersionSource[] = [
  { type: 'header', name: 'accept-version' },
  { type: 'header', name: 'api-version' },
  { type: 'path' },
  { type: 'query', name: 'api_version' },
  { type: 'query', name: 'version' },
  { type: 'body', name: 'version' },
];

export class VersionDetectionError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'VersionDetectionError';
  }
}

/** Detects the first version in configured source order. */
export class VersionDetector {
  private sources: VersionSource[];

  constructor(
    private config: VersioningConfig | undefined,
    private normalizer: VersionNormalizer,
    private defaultVersion: string,
  ) {
    this.sources = (config?.sources ?? DEFAULT_SOURCES).map((source) => ({
      ...source,
      name: source.type === 'header' ? source.name?.toLowerCase() : source.name,
      pattern:
        source.type === 'path'
          ? new RegExp(
              source.pattern?.source ?? '/(v\\d+)(?=/|$)',
              source.pattern?.flags.replace(/[gy]/g, '') ?? '',
            )
          : source.pattern,
    }));
  }

  detect(
    headers: Record<string, string>,
    path: string,
    query: Record<string, string>,
    body?: Record<string, unknown>,
  ): VersionResult {
    for (const source of this.sources) {
      let value: unknown;
      switch (source.type) {
        case 'header':
          value = headers[source.name ?? ''];
          break;
        case 'path':
          value = source.pattern?.exec(path)?.[1];
          break;
        case 'query':
          value = query[source.name ?? 'api_version'];
          break;
        case 'body':
          value = body?.[source.name ?? 'version'];
          break;
      }
      if (typeof value !== 'string' || !value.trim()) continue;
      const trimmed = value.trim();
      let version: string;
      if (source.type === 'header' && trimmed.includes(',')) {
        const candidates = trimmed
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        if (!candidates.length) continue;
        version = this.negotiate(candidates);
      } else if (this.normalizer.isValid(trimmed)) {
        version = trimmed;
      } else if (this.config?.onInvalid === 'use-default') {
        version = this.defaultVersion;
      } else {
        throw new VersionDetectionError(
          `Invalid API version in ${source.type}: "${trimmed}"`,
          'INVALID_API_VERSION',
        );
      }
      return {
        version: this.normalizer.resolveAlias(version),
        source: source.type,
        ...(source.type === 'header' ? { headerName: source.name } : {}),
      };
    }
    if (this.config?.onMissing === 'reject') {
      throw new VersionDetectionError('No API version found in request', 'MISSING_API_VERSION');
    }
    const version =
      this.config?.onMissing === 'use-oldest'
        ? (this.normalizer.listVersions()[0]?.name ?? this.defaultVersion)
        : this.defaultVersion;
    return { version: this.normalizer.resolveAlias(version), source: 'default' };
  }

  private negotiate(versions: string[]): string {
    const strategy = this.config?.negotiation?.strategy ?? 'highest-supported';
    let selected: string | undefined;
    for (const version of versions) {
      if (!this.normalizer.isValid(version)) continue;
      if (strategy !== 'highest-supported') return version;
      if (!selected || this.normalizer.compare(version, selected) > 0) selected = version;
    }
    if (selected) return selected;
    if (this.config?.negotiation?.onUnsupported === 'reject') {
      throw new VersionDetectionError(
        `No supported API version found in: ${versions.join(', ')}`,
        'UNSUPPORTED_API_VERSION',
      );
    }
    return this.defaultVersion;
  }
}
