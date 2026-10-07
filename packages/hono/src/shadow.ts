import type { Pylon } from '@ossl/pylon-core';
import type { MiddlewareHandler } from 'hono';
import type { PylonHonoOptions } from './index.js';

const LOG_PREFIX = '[pylon:shadow]';

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

  if (contentType.includes('json')) {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  try {
    const text = await c.req.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shadow mode middleware that logs what Pylon WOULD do without transforming.
 *
 * Use during migration to validate Pylon transforms against existing versioning.
 *
 * Usage:
 * ```typescript
 * import { Pylon } from '@ossl/pylon-core';
 * import { pylonHonoShadow } from '@ossl/pylon-hono/shadow';
 *
 * const pylon = new Pylon({ ... });
 * app.use('*', pylonHonoShadow(pylon));
 * // Check logs for discrepancies between actual and transformed
 * ```
 *
 * The middleware runs the full Pylon pipeline but does NOT modify the
 * request or response.  Differences between original and transformed
 * payloads are logged with a `[pylon:shadow]` prefix.
 *
 * @param pylon - A configured Pylon instance
 * @param options - Optional endpoint override
 */
export function pylonHonoShadow(pylon: Pylon, options?: PylonHonoOptions): MiddlewareHandler {
  return async (c, next) => {
    /* ---- REQUEST (shadow) ---- */

    const headers = collectHeaders(c);
    const path = c.req.path as string;
    const query = collectQuery(c);
    const body = await readBody(c);

    const reqResult = await pylon.processRequest(headers, path, query, body, {
      endpoint: options?.endpoint,
    });

    // Log what version was detected and what transforms would run.
    console.log(
      `${LOG_PREFIX} Request: version=${reqResult.version},` +
        ` transforms=${reqResult.transformResult.status}`,
    );

    if (reqResult.debug && reqResult.debug.transformsApplied.length > 0) {
      console.log(
        `${LOG_PREFIX}   transforms applied: ${reqResult.debug.transformsApplied.join(', ')}`,
      );
    }

    if (reqResult.transformResult.status === 'error') {
      console.log(`${LOG_PREFIX}   WOULD return error: ${JSON.stringify(reqResult.body)}`);
    } else if (
      reqResult.body !== undefined &&
      body !== undefined &&
      JSON.stringify(reqResult.body) !== JSON.stringify(body)
    ) {
      console.log(`${LOG_PREFIX}   WOULD transform request body`);
      console.log(`${LOG_PREFIX}     original:    ${JSON.stringify(body)}`);
      console.log(`${LOG_PREFIX}     transformed: ${JSON.stringify(reqResult.body)}`);
    } else {
      console.log(`${LOG_PREFIX}   no request body transformation needed`);
    }

    /* ---- RESPONSE (shadow) ---- */

    await next();

    if (!c.finalized) {
      return;
    }

    const clientVersion = reqResult.version;
    if (!clientVersion || clientVersion === pylon.current) {
      return;
    }

    // Read response body (clone to avoid consuming)
    const res = c.res;
    const resContentType = res.headers.get('content-type') ?? '';
    let resBody: unknown;

    try {
      if (resContentType.includes('json')) {
        resBody = await res.clone().json();
      } else {
        const text = await res.clone().text();
        resBody = text || undefined;
      }
    } catch {
      resBody = undefined;
    }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    const transformsApplied: string[] = reqResult.debug?.transformsApplied ?? [];

    const resResult = await pylon.processResponse(
      clientVersion,
      resBody,
      resHeaders,
      transformsApplied,
      reqResult.debug,
    );

    // Log what would change on the response
    if (
      resResult.body !== undefined &&
      resBody !== undefined &&
      JSON.stringify(resResult.body) !== JSON.stringify(resBody)
    ) {
      console.log(`${LOG_PREFIX}   WOULD transform response body`);
      console.log(`${LOG_PREFIX}     original:    ${JSON.stringify(resBody)}`);
      console.log(`${LOG_PREFIX}     transformed: ${JSON.stringify(resResult.body)}`);
    } else {
      console.log(`${LOG_PREFIX}   no response body transformation needed`);
    }
  };
}
