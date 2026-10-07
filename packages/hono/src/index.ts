import type { DebugInfo, Pylon } from '@ossl/pylon-core';
import { isJSONContentType, mergeResponseHeaders } from '@ossl/pylon-core';
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
  return isJSONContentType(contentType) ? c.req.json() : undefined;
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
  const root = options?.endpoint ? pylon.forEndpoint(options.endpoint) : pylon;
  return async (c, next) => {
    const pylon = root.forRoute(c.req.method, c.req.path);
    if (!pylon.hasPipeline) return next();
    /* ---- REQUEST PHASE ---- */

    // 1. Extract request components
    const headers = collectHeaders(c);
    const path = c.req.path as string;
    const query = collectQuery(c);
    let body: unknown;
    try {
      body = await readBody(c);
    } catch {
      return c.json(
        { error: { code: 'INVALID_JSON', message: 'Malformed JSON request body' } },
        400,
      );
    }

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
    if (reqResult.body !== undefined && reqResult.body !== body) {
      // Hono stores Promises in bodyCache even though the TS types say `string`.
      // biome-ignore lint/suspicious/noExplicitAny: bodyCache stores Promises at runtime
      (c.req as any).bodyCache = {
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
    if (
      !clientVersion ||
      c.req.method === 'HEAD' ||
      !pylon.needsResponseProcessing(clientVersion, c.res.status)
    ) {
      // No version mismatch — nothing to reverse-transform
      return;
    }

    const debug: DebugInfo | undefined = c.get('pylon-debug');

    // The response body will be replaced after processing.
    const resContentType = c.res.headers.get('content-type') ?? '';
    if (!c.res.body || !isJSONContentType(resContentType)) return;
    // Hono may rebuild its Response when changing headers. Read the resulting instance.
    if (c.res.headers.has('content-length')) c.header('content-length', undefined);
    const res = c.res;
    let resBody: unknown;

    try {
      resBody = await res.json();
    } catch {
      c.res = Response.json(
        { error: { code: 'RESPONSE_TRANSFORM_FAILED', message: 'Malformed JSON response body' } },
        { status: 500, headers: reqResult.headers },
      );
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
      res.status,
    );

    delete resResult.headers['content-length'];

    // 8. Build the final transformed response
    const newBodyStr = resResult.body !== undefined ? JSON.stringify(resResult.body) : null;

    const transformedHeaders = mergeResponseHeaders(res.headers, resResult.headers);
    transformedHeaders.delete('content-length');
    c.res = new Response(newBodyStr, {
      status: resResult.status ?? res.status,
      statusText: resResult.status ? undefined : res.statusText,
      headers: transformedHeaders,
    });
  };
}
