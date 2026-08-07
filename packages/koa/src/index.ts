import type { Pylon, DebugInfo } from '@ossl/pylon-core';
import type { Middleware, ParameterizedContext, DefaultState, DefaultContext } from 'koa';

export interface PylonKoaOptions {
  /** Override endpoint name for per-endpoint config */
  endpoint?: string;
  /** Shadow mode: log only, no transform */
  shadow?: boolean;
}

// Extend Koa context to store Pylon metadata
declare module 'koa' {
  interface DefaultContext {
    pylonClientVersion?: string;
    pylonTransformInfo?: {
      transformsApplied: string[];
      debugInfo?: unknown;
    };
  }
}

/**
 * Koa middleware for Pylon API versioning.
 * Koa provides clean response interception via ctx.body.
 *
 * Usage:
 * ```typescript
 * import Koa from 'koa';
 * import { pylonKoa } from '@ossl/pylon-koa';
 * import { Pylon } from '@ossl/pylon-core';
 *
 * const app = new Koa();
 * const pylon = new Pylon({ ... });
 * app.use(pylonKoa(pylon));
 * ```
 *
 * How it works:
 * 1. Request phase: detect version from headers/URL, transform request body
 * 2. Response phase: intercept ctx.body via assignment, transform back to client version
 * 3. Set version headers on response
 */
export function pylonKoa(pylon: Pylon, options?: PylonKoaOptions): Middleware {
  return async (ctx: ParameterizedContext<DefaultState, DefaultContext>, next: () => Promise<unknown>) => {
    // 1. Extract request data
    const headers = extractHeaders(ctx);
    const query = extractQuery(ctx);
    // Koa does not include body parsing by default.
    // When body-parser middleware (e.g., koa-body, @koa/bodyparser) is used,
    // it attaches body to the request object. Access via unknown cast.
    const reqUnknown = ctx.request as unknown as Record<string, unknown>;
    const body = reqUnknown.body as Record<string, unknown> | undefined;

    // 2. Process request through Pylon
    const result = await pylon.processRequest(headers, ctx.path, query, body, {
      endpoint: options?.endpoint,
    });

    // Store client version for response phase
    ctx.pylonClientVersion = result.version;
    const debug = result.debug;
    ctx.pylonTransformInfo = {
      transformsApplied: debug?.transformsApplied ?? [],
      debugInfo: debug,
    };

    // If error, return Pylon error response
    if (result.transformResult.status === 'error' && result.transformResult.error) {
      ctx.status = result.transformResult.error.code === 'VERSION_UNPUBLISHED' ? 410 : 422;
      ctx.body = result.transformResult.error;
      for (const [key, value] of Object.entries(result.headers)) {
        if (value !== undefined) {
          ctx.set(key, value);
        }
      }
      return;
    }

    // In shadow mode, log and continue without modifying
    if (options?.shadow) {
      // Set Pylon response headers even in shadow mode
      setHeaders(ctx, result.headers);
      // biome-ignore lint: shadow mode diagnostic logging
      console.log(`[pylon:shadow] ${ctx.method} ${ctx.path}`);
      // biome-ignore lint: shadow mode diagnostic logging
      console.log(`[pylon:shadow] Client version: ${result.version}, Current: ${pylon.current}`);
      // biome-ignore lint: shadow mode diagnostic logging
      console.log(`[pylon:shadow] Transforms: ${debug?.transformsApplied.join(' -> ') || 'none'}`);
      await next();
      return;
    }

    // 3. Replace request body with transformed body
    if (result.body !== undefined) {
      reqUnknown.body = result.body;
    }

    // 4. Await downstream middleware
    await next();

    // 5. Transform response back to client version
    if (ctx.pylonClientVersion !== pylon.current && ctx.body !== undefined && ctx.body !== null) {
      try {
        // Koa ctx.body can be string, Buffer, stream, or object.
        // We only attempt to transform JSON-serializable objects (most common for APIs).
        const responseBodyStr =
          typeof ctx.body === 'object'
            ? JSON.stringify(ctx.body)
            : String(ctx.body);

        let responseBody: unknown;
        try {
          responseBody = JSON.parse(responseBodyStr) as unknown;
        } catch {
          // If body is not JSON, skip transform (streams, buffers, plain text)
          setHeaders(ctx, result.headers);
          return;
        }

        const responseResult = await pylon.processResponse(
          ctx.pylonClientVersion,
          responseBody,
          {},
          ctx.pylonTransformInfo?.transformsApplied ?? [],
          ctx.pylonTransformInfo?.debugInfo as DebugInfo | undefined,
        );

        ctx.body = responseResult.body;
        setHeaders(ctx, { ...result.headers, ...responseResult.headers });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pylon] Response transform failed: ${message}`);
        // Fall through with original body
        setHeaders(ctx, result.headers);
      }
    } else {
      setHeaders(ctx, result.headers);
    }
  };
}

/**
 * Shadow mode Koa middleware.
 * Logs what Pylon would do without transforming request or response data.
 */
export function pylonKoaShadow(pylon: Pylon, options?: PylonKoaOptions): Middleware {
  return pylonKoa(pylon, { ...options, shadow: true });
}

function extractHeaders(ctx: ParameterizedContext<DefaultState, DefaultContext>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return headers;
}

function extractQuery(ctx: ParameterizedContext<DefaultState, DefaultContext>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.query)) {
    if (value !== undefined) {
      query[key] = Array.isArray(value) ? (value[0] ?? String(value)) : String(value);
    }
  }
  return query;
}

function setHeaders(ctx: ParameterizedContext<DefaultState, DefaultContext>, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      ctx.set(key, value);
    }
  }
}
