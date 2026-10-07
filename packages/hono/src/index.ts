import type { DebugInfo, Pylon } from '@ossl/pylon-core';
import type { MiddlewareHandler } from 'hono';

export interface PylonHonoOptions {
  /** Override endpoint name for per-endpoint config */
  endpoint?: string;
}

/**
 * Collect all request headers into a plain record.
 */
function collectHeaders(c: { req: { raw: { headers: Headers } } }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    headers[key] = value;
  }
  return headers;
}

/**
 * Collect query parameters into a plain record.
 * Hono exposes queries as `Record<string, string[]>`; we take the first value.
 */
function collectQuery(c: { req: { queries(): Record<string, string[]> } }): Record<string, string> {
  const query: Record<string, string> = {};
  const entries = c.req.queries();
  const keys = Object.keys(entries) as Array<keyof typeof entries>;
  for (const key of keys) {
    const values = entries[key];
    if (values && values.length > 0) {
      query[key as string] = values[0] as string;
    }
  }
  return query;
}

/**
 * Read and parse the request body.
 *
 * Handles JSON and text content types.  Returns `undefined` for methods
 * that carry no body (GET/HEAD) or when the body is empty / unparseable.
 */
async function readBody(c: {
  req: {
    raw: { method: string };
    header(name: string): string | undefined;
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
  };
}): Promise<unknown> {
  const method = c.req.raw.method;
  if (method === 'GET' || method === 'HEAD') {
    return undefined;
  }

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType) {
    return undefined;
  }

  // JSON content-type
  if (contentType.includes('json')) {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  // All other content types — read as text
  try {
    const text = await c.req.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hono middleware that intercepts requests and applies Pylon version transforms.
 *
 * Usage:
 * ```typescript
 * import { Pylon } from '@ossl/pylon-core';
 * import { pylonHono } from '@ossl/pylon-hono';
 *
 * const pylon = new Pylon({ ... });
 * app.use('*', pylonHono(pylon));
 *
 * // Or per-endpoint:
 * app.use('/api/*', pylonHono(pylon, { endpoint: 'POST /api/users' }));
 * ```
 *
 * How it works:
 * 1. Detect client version from headers/URL/query
 * 2. Transform request body to current version (replaces `c.req.bodyCache`)
 * 3. Set version headers on the response
 * 4. Intercept response after downstream handler
 * 5. Transform response body back to client version
 * 6. Inject version headers
 *
 * @param pylon - A configured Pylon instance
 * @param options - Optional endpoint override
 */
export function pylonHono(pylon: Pylon, options?: PylonHonoOptions): MiddlewareHandler {
  pylon = options?.endpoint ? pylon.forEndpoint(options.endpoint) : pylon;
  return async (c, next) => {
    /* ---- REQUEST PHASE ---- */

    // 1. Extract request components
    const headers = collectHeaders(c);
    const path = c.req.path as string;
    const query = collectQuery(c);
    const body = await readBody(c);

    // 2. Process request through the Pylon pipeline
    const reqResult = await pylon.processRequest(headers, path, query, body, {
      endpoint: options?.endpoint,
    });

    // 3. Persist metadata for the response phase
    c.set('pylon-client-version', reqResult.version);
    c.set('pylon-transform-result', reqResult.transformResult);
    c.set('pylon-debug', reqResult.debug);

    // 4. Handle transform / validation errors — respond immediately
    if (reqResult.transformResult.status === 'error') {
      for (const [key, value] of Object.entries(reqResult.headers)) {
        c.header(key, value as string);
      }
      return c.json(reqResult.body, (reqResult.status ?? 422) as 400 | 410 | 422 | 500);
    }

    // 5. Set version / deprecation response headers
    for (const [key, value] of Object.entries(reqResult.headers)) {
      c.header(key, value as string);
    }

    // 6. Replace body cache so downstream `c.req.json()` / `c.req.text()`
    //    receives the *transformed* body rather than the original.
    if (reqResult.body !== undefined && body !== undefined) {
      const serialized =
        typeof reqResult.body === 'string' ? reqResult.body : JSON.stringify(reqResult.body);
      // Hono stores Promises in bodyCache even though the TS types say `string`.
      // biome-ignore lint/suspicious/noExplicitAny: bodyCache stores Promises at runtime
      (c.req as any).bodyCache = {
        text: Promise.resolve(serialized),
        json: Promise.resolve(reqResult.body),
      };
    }

    /* ---- RESPONSE PHASE ---- */

    await next();

    // Nothing to transform if no response was produced
    if (!c.finalized) {
      return;
    }

    const clientVersion: string | undefined = c.get('pylon-client-version');
    if (!clientVersion || clientVersion === pylon.current) {
      // No version mismatch — nothing to reverse-transform
      return;
    }

    const debug: DebugInfo | undefined = c.get('pylon-debug');

    // Read the response body (clone so we don't consume the original)
    const res = c.res;
    const resContentType = res.headers.get('content-type') ?? '';
    if (!res.body || !resContentType.includes('json')) return;
    let resBody: unknown;

    try {
      resBody = await res.clone().json();
    } catch {
      return;
    }

    // Collect original response headers
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    // 7. Transform response back to the caller's version
    const transformsApplied: string[] = debug?.transformsApplied ?? [];
    const resResult = await pylon.processResponse(
      clientVersion,
      resBody,
      resHeaders,
      transformsApplied,
      debug,
    );

    delete resResult.headers['content-length'];
    c.header('content-length', undefined);

    // 8. Build the final transformed response
    const newBodyStr = resResult.body !== undefined ? JSON.stringify(resResult.body) : null;

    // Apply result headers onto the response before replacing the body,
    // so the Context setter preserves them through its header-merge logic.
    for (const [key, value] of Object.entries(resResult.headers)) {
      c.header(key, value as string);
    }

    c.res = new Response(newBodyStr, {
      status: resResult.status ?? res.status,
      statusText: resResult.status ? undefined : res.statusText,
    });
  };
}
