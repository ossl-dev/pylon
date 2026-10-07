import type { Pylon } from '@ossl/pylon-core';

/**
 * Type for the request helper passed to timeTravel and snapshotVersion callbacks.
 */
export type VersionedRequest = <T>(
  method: string,
  path: string,
  options?: VersionedRequestOptions,
) => Promise<VersionedResponse<T>>;

/**
 * Options passed to the VersionedRequest helper.
 */
export interface VersionedRequestOptions {
  /** Request body (in the current/latest version format) */
  body?: any;
  /** Additional request headers */
  headers?: Record<string, string>;
  /** Query parameters to append to the URL */
  query?: Record<string, string>;
}

/**
 * Response returned by the VersionedRequest helper.
 * The body is always in the current/latest version format for assertions.
 */
export interface VersionedResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

/**
 * Options for timeTravel.
 */
export interface TimeTravelOptions {
  /**
   * Specific versions to test against.
   * When omitted, all versions known to the normalizer are tested.
   */
  versions?: string[];

  /**
   * Base URL for HTTP requests.
   * @default 'http://localhost:3000'
   */
  baseUrl?: string;

  /**
   * Custom fetch implementation.
   * Useful for injecting MSW, Polly.js, or other test doubles.
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;
}

/**
 * Run a test callback against every historical API version.
 *
 * For each version the callback receives (version, request) where `request`
 * is a helper that transparently handles request/response version
 * transformation:
 *
 *  1. The request body (supplied in the **current** version format) is
 *     **downgraded** to the target version via `pylon.transform()` with
 *     direction `'response'`.
 *  2. The downgraded body is sent to the test server using `fetch()`.
 *  3. The server response (in the target version format) is **upgraded**
 *     back to the current version via `pylon.transform()` with direction
 *     `'request'` so assertions can use a single format.
 *
 * @example
 * ```ts
 * timeTravel(pylon, async (version, request) => {
 *   const response = await request('POST', '/users', {
 *     body: { fullName: 'John Doe', email: 'john@test.com' },
 *   });
 *   expect(response.status).toBe(201);
 * });
 * ```
 *
 * The test above runs against v1, v2, v3, v4 (etc.) automatically.
 *
 * @param pylon - A configured Pylon instance
 * @param callback - Async callback invoked once per version with (version, request)
 * @param options - Optional version filter and fetch configuration
 */
export async function timeTravel(
  pylon: Pylon,
  callback: (version: string, request: VersionedRequest) => Promise<void>,
  options?: TimeTravelOptions,
): Promise<void> {
  const allVersions = pylon.normalizer.listVersions().map((v) => v.name);
  const targetVersions = options?.versions
    ? allVersions.filter((v) => options.versions!.includes(v))
    : allVersions;

  const current = pylon.current;
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000';
  const fetchFn = options?.fetch ?? globalThis.fetch;

  for (const version of targetVersions) {
    const request: VersionedRequest = async (method, path, opts) => {
      // 1. Downgrade the request body from current-version format to
      //    the target-version format.
      let body: unknown = opts?.body;
      if (body !== undefined) {
        const result = await pylon.transform(current, version, 'response', body);
        if (result.status !== 'error') {
          body = result.data;
        } else if (result.status === 'error') {
          throw new Error(
            `[timeTravel] Failed to downgrade body from "${current}" to "${version}": ${result.error?.message ?? 'Unknown error'}`,
          );
        }
      }

      // 2. Build URL with query parameters.
      const url = new URL(path, baseUrl);
      if (opts?.query) {
        for (const [key, value] of Object.entries(opts.query)) {
          url.searchParams.set(key, value);
        }
      }

      // 3. Build fetch init.
      const headers = new Headers(opts?.headers);
      headers.set('content-type', 'application/json');
      headers.set(
        pylon.config.versioning?.sources.find((source) => source.type === 'header')?.name ??
          'api-version',
        version,
      );
      const fetchInit: RequestInit = {
        method,
        headers: Object.fromEntries(headers),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      };

      // 4. Dispatch the HTTP request.
      const response = await fetchFn(url.toString(), fetchInit);

      // 5. Read response headers.
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // 6. Read response body.
      const contentType = response.headers.get('content-type') ?? '';
      let responseBody: unknown;
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      // 7. Upgrade the response body back to current-version format
      //    so all assertions use the same schema.
      if (responseBody !== undefined && responseBody !== null && typeof responseBody === 'object') {
        const result = await pylon.transform(version, current, 'request', responseBody);
        if (result.status === 'error')
          throw new Error(
            `[timeTravel] Failed to upgrade response from "${version}" to "${current}": ${result.error?.message ?? 'Unknown error'}`,
          );
        responseBody = result.data;
      }

      return {
        status: response.status,
        body: responseBody as any,
        headers: responseHeaders,
      };
    };

    await callback(version, request);
  }
}
