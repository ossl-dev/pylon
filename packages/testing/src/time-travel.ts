import type { Pylon } from '@ossl/pylon-core';
import { isJSONContentType } from '@ossl/pylon-core';

export type VersionedRequest = <T = unknown>(
  method: string,
  path: string,
  options?: VersionedRequestOptions,
) => Promise<VersionedResponse<T>>;

export interface VersionedRequestOptions {
  /** Body in the selected version's wire format. */
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface VersionedResponse<T = unknown> {
  status: number;
  /** Actual wire response, including fields lost in historical migrations. */
  body: T;
  headers: Record<string, string>;
}

export interface TimeTravelOptions {
  versions?: string[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Run assertions against each published contract using version-specific fixtures. */
export async function timeTravel(
  pylon: Pylon,
  callback: (version: string, request: VersionedRequest) => Promise<void>,
  options: TimeTravelOptions = {},
): Promise<void> {
  const versions =
    options.versions ??
    pylon.normalizer
      .listVersions()
      .filter(
        (v) =>
          !pylon.isUnpublished(v.name) &&
          (!pylon.config.contracts || Object.hasOwn(pylon.config.contracts, v.name)),
      )
      .map((v) => v.name);
  const selected = new Set<string>();
  for (const version of versions) {
    if (!pylon.normalizer.isValid(version)) throw new Error(`Unknown test version: "${version}"`);
    selected.add(pylon.normalizer.resolveAlias(version));
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!selected.size) throw new Error('No published versions selected for contract tests');
  for (const version of selected) {
    const request: VersionedRequest = async (method, path, opts) => {
      method = method.toUpperCase();
      const url = new URL(
        path.replaceAll('{version}', encodeURIComponent(version)),
        options.baseUrl ?? 'http://localhost:3000',
      );
      for (const [key, value] of Object.entries(opts?.query ?? {}))
        url.searchParams.set(key, value);
      const headers = new Headers(opts?.headers);
      let body = opts?.body;
      const sources = pylon.config.versioning?.sources ?? [
        { type: 'header', name: 'accept-version' },
      ];
      const source =
        sources.find((s) => s.type === 'header') ??
        sources.find((s) => s.type === 'query') ??
        sources.find((s) => s.type === 'body');
      if (source?.type === 'header') {
        if (!source.name) throw new Error('Version header source requires a name');
        headers.set(source.name, version);
      } else if (source?.type === 'query') {
        url.searchParams.set(source.name ?? 'api_version', version);
      } else if (source?.type === 'body') {
        if (
          body === null ||
          (body !== undefined && (typeof body !== 'object' || Array.isArray(body)))
        )
          throw new Error('Body versioning requires an object fixture');
        body = { ...(body as Record<string, unknown>), [source.name ?? 'version']: version };
      }
      if (body !== undefined && (method === 'GET' || method === 'HEAD'))
        throw new Error(`${method} fixtures cannot contain a body`);
      const detected = pylon.detectVersion(
        Object.fromEntries(headers),
        url.pathname,
        Object.fromEntries(url.searchParams),
        body,
      ).version;
      if (detected !== version)
        throw new Error(
          `Test request selects "${detected}" instead of "${version}". For path versioning, use /{version}/...`,
        );
      if (body !== undefined && !headers.has('content-type'))
        headers.set('content-type', 'application/json');
      const response = await fetchFn(url.toString(), {
        method,
        headers: Object.fromEntries(headers),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const responseBody =
        method === 'HEAD' || [204, 205, 304].includes(response.status)
          ? undefined
          : isJSONContentType(contentType)
            ? await response.json()
            : await response.text();
      return {
        status: response.status,
        body: responseBody,
        headers: Object.fromEntries(response.headers),
      };
    };
    await callback(version, request);
  }
}
