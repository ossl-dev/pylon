import type { Pylon } from '@ossl/pylon-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Shadow-mode Express middleware for Pylon API versioning.
 *
 * Runs the full Pylon request and response pipeline but **does not**
 * modify `req.body` or any outgoing response. Instead it logs what
 * Pylon **would** do, prefixed with `[pylon:shadow]`.
 *
 * Use during migration to validate Pylon transforms before enabling
 * them in production. Combine this with the `pylonExpress` middleware
 * (without shadow mode) after you have validated the transform output.
 *
 * Request flow:
 * 1. Normalize Express request components
 * 2. Call `pylon.processRequest()` — logs detected version and
 *    transform status
 * 3. Monkey-patches `res.json`, `res.send`, and `res.end` to log the
 *    response transform that would be applied
 * 4. Calls `next()` — all downstream middleware and routes see the
 *    **original** request body
 *
 * @example
 * ```ts
 * import { pylonExpressShadow } from '@ossl/pylon-express';
 * import { Pylon } from '@ossl/pylon-core';
 *
 * const pylon = new Pylon({ ... });
 *
 * // Log what Pylon would do while the app still runs unchanged
 * app.use(pylonExpressShadow(pylon));
 * ```
 *
 * @param pylon - A configured Pylon instance
 * @param options - Optional endpoint override
 * @returns Express request handler middleware
 */
export function pylonExpressShadow(pylon: Pylon, options?: { endpoint?: string }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // ---------------------------------------------------------------
    // 1. Normalize Express request components (same as pylonExpress)
    // ---------------------------------------------------------------

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        const first = value[0];
        if (typeof first === 'string') {
          headers[key] = first;
        }
      }
    }

    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        query[key] = value;
      } else if (Array.isArray(value)) {
        const first = value[0];
        if (typeof first === 'string') {
          query[key] = first;
        }
      }
    }

    // ---------------------------------------------------------------
    // 2. Run the Pylon request pipeline (observational only)
    // ---------------------------------------------------------------

    pylon
      .processRequest(headers, req.path, query, req.body, {
        endpoint: options?.endpoint,
      })
      .then((processResult) => {
        // Log version detection results
        console.log(`[pylon:shadow] Detected version: ${processResult.version}`);
        console.log(`[pylon:shadow] Transform status: ${processResult.transformResult.status}`);

        if (processResult.transformResult.status === 'error') {
          console.log(
            `[pylon:shadow] Transform error: ${processResult.transformResult.error?.message ?? 'Unknown error'}`,
          );
        }

        if (processResult.body !== req.body) {
          console.log(
            `[pylon:shadow] Request body would be transformed from version ${processResult.version} to ${pylon.current}`,
          );
        }

        // Store version information on the request for downstream access
        req.pylonClientVersion = processResult.version;

        const transformsApplied = processResult.debug?.transformsApplied ?? [];
        req.pylonTransformInfo = {
          transformsApplied,
          debugInfo: processResult.debug,
        };

        // NOTE: req.body is deliberately NOT replaced — this is shadow mode

        // ---------------------------------------------------------------
        // 3. Monkey-patch response methods (log only, no transform)
        // ---------------------------------------------------------------

        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        const originalEnd = res.end.bind(res);

        let intercepted = false;

        const restore = (): void => {
          res.json = originalJson;
          res.send = originalSend;
          res.end = originalEnd;
        };

        // Override res.json
        res.json = (body?: unknown): Response => {
          if (intercepted) return originalJson.call(res, body);
          intercepted = true;
          restore();

          console.log(
            `[pylon:shadow] Would transform response from ${pylon.current} to ${req.pylonClientVersion}`,
          );

          return originalJson.call(res, body);
        };

        // Override res.send
        res.send = (body?: unknown): Response => {
          if (intercepted) return originalSend.call(res, body);
          intercepted = true;
          restore();

          console.log(
            `[pylon:shadow] Would transform response from ${pylon.current} to ${req.pylonClientVersion}`,
          );

          return originalSend.call(res, body);
        };

        // Override res.end — Express 5 has three overloads (callback-only,
        // chunk+callback, chunk+encoding+callback), so we use a rest
        // signature that accepts all of them.
        res.end = (...args: any[]): Response => {
          if (intercepted) return res;
          intercepted = true;
          restore();

          const [data] = args;

          if (data !== undefined && data !== null && typeof data !== 'function') {
            console.log(
              `[pylon:shadow] Would transform response from ${pylon.current} to ${req.pylonClientVersion}`,
            );
          }

          return (originalEnd as Function).apply(res, args);
        };

        // Safety net: restore originals if the response finishes without
        // interception
        res.once('finish', restore);
        res.once('close', restore);

        // 4. Continue to the next middleware / route handler
        next();
      })
      .catch((err: unknown) => {
        console.log(
          `[pylon:shadow] Pylon request processing error: ${err instanceof Error ? err.message : String(err)}`,
        );
        next(err instanceof Error ? err : new Error(String(err)));
      });
  };
}
