import type { Pylon } from '@ossl/pylon-core';
import type { VersionedRequest } from './time-travel.js';

/**
 * Result of a per-version snapshot.
 */
export interface SnapshotResult {
  /** The API version that was tested */
  version: string;
  /** Response data for this version (in current-version format) */
  data: any;
}

/**
 * Options for snapshotVersion.
 */
export interface SnapshotOptions {
  /**
   * Specific versions to snapshot.
   * When omitted, all versions known to the normalizer are snapshot.
   */
  versions?: string[];

  /**
   * Base URL for HTTP requests.
   * @default 'http://localhost:3000'
   */
  baseUrl?: string;

  /**
   * Custom fetch implementation.
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;
}

/**
 * Generate response snapshots for each API version.
 *
 * The `fetcher` callback receives a `VersionedRequest` helper and returns
 * the response data. `snapshotVersion` automatically transforms the request
 * body and response between the current version and each target version
 * (same mechanism as {@link timeTravel}).
 *
 * Useful for detecting unexpected changes in transforms — pair the output
 * with Jest/Vitest snapshot matchers.
 *
 * @example
 * ```ts
 * const snapshots = await snapshotVersion(pylon, async (request) => {
 *   const res = await request('GET', '/users/1');
 *   return res.body;
 * });
 * snapshots.forEach((s) => expect(s.data).toMatchSnapshot());
 * ```
 *
 * @param pylon - A configured Pylon instance
 * @param fetcher - Async callback called once per version with a request helper;
 *                  return the data to snapshot
 * @param options - Optional version filter and fetch configuration
 * @returns Array of snapshot results, one per version
 */
export async function snapshotVersion(
  pylon: Pylon,
  fetcher: (request: VersionedRequest) => Promise<any>,
  options?: SnapshotOptions,
): Promise<SnapshotResult[]> {
  const allVersions = pylon.normalizer.listVersions().map((v) => v.name);
  const targetVersions = options?.versions
    ? allVersions.filter((v) => options.versions!.includes(v))
    : allVersions;

  const current = pylon.current;
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000';
  const fetchFn = options?.fetch ?? globalThis.fetch;

  const results: SnapshotResult[] = [];

  for (const version of targetVersions) {
    const request: VersionedRequest = async (method, path, opts) => {
      let body: unknown = opts?.body;
      if (body !== undefined) {
        const result = await pylon.transform(current, version, 'response', body);
        if (result.status === 'success' && result.data !== undefined) {
          body = result.data;
        } else if (result.status === 'error') {
          throw new Error(
            `[snapshotVersion] Failed to downgrade body from "${current}" to "${version}": ${result.error?.message ?? 'Unknown error'}`,
          );
        }
      }

      const url = new URL(path, baseUrl);
      if (opts?.query) {
        for (const [key, value] of Object.entries(opts.query)) {
          url.searchParams.set(key, value);
        }
      }

      const fetchInit: RequestInit = {
        method,
        headers: {
          'content-type': 'application/json',
          ...(opts?.headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      };

      const response = await fetchFn(url.toString(), fetchInit);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown;
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      if (responseBody !== undefined && responseBody !== null && typeof responseBody === 'object') {
        const result = await pylon.transform(version, current, 'request', responseBody);
        if (result.status === 'success' && result.data !== undefined) {
          responseBody = result.data;
        }
      }

      return {
        status: response.status,
        body: responseBody as any,
        headers: responseHeaders,
      };
    };

    const data = await fetcher(request);
    results.push({ version, data });
  }

  return results;
}
