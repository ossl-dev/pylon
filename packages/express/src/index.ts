import type { Pylon } from '@ossl/pylon-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface PylonExpressOptions {
  /**
   * Override endpoint name for per-endpoint config.
   * Passed through to Pylon.processRequest and Pylon.forEndpoint.
   */
  endpoint?: string;
  /**
   * Shadow mode: log only, no transform.
   * When enabled, Pylon processes the request and response but
   * does not modify req.body or the outgoing response body.
   */
  shadow?: boolean;
}

/**
 * Express middleware for Pylon API versioning.
 *
 * WARNING: Express has no official response interception mechanism.
 * This adapter monkey-patches `res.json()`, `res.send()`, and `res.end()`
 * to intercept outgoing responses. It restores the originals after each
 * response. This works for most Express apps but may conflict with
 * middleware that also patches these methods.
 *
 * For new projects, prefer Hono or Fastify.
 *
 * Request flow:
 * 1. Normalize Express headers and query parameters to plain objects
 * 2. Call `pylon.processRequest()` to detect the client version and
 *    optionally transform the request body
 * 3. Store the detected version on `req.pylonClientVersion`
 * 4. Replace `req.body` with the Pylon-transformed body
 * 5. Monkey-patch `res.json`, `res.send`, and `res.end` to intercept the
 *    outgoing response
 * 6. Call `next()` to continue the middleware chain
 *
 * Response flow (when the patched method is called):
 * 1. Call `pylon.processResponse()` to transform the body back to the
 *    client version
 * 2. Set Pylon version headers on the response (X-API-Version, etc.)
 * 3. Call the original method with the transformed body
 *
 * @example
 * ```ts
 * import { pylonExpress } from '@ossl/pylon-express';
 * import { Pylon } from '@ossl/pylon-core';
 *
 * const pylon = new Pylon({
 *   current: 'v2',
 *   schemas: { v1: schemaV1, v2: schemaV2 },
 *   transforms: { 'v1->v2': { request: v1toV2 } },
 * });
 *
 * // Global middleware: all routes go through Pylon
 * app.use(pylonExpress(pylon));
 *
 * // Per-endpoint: only intercept POST /users
 * app.post(
 *   '/users',
 *   pylonExpress(pylon, { endpoint: 'POST /users' }),
 *   v4Handler,
 * );
 * ```
 *
 * @param pylon - A configured Pylon instance
 * @param options - Optional endpoint or shadow configuration
 * @returns Express request handler middleware
 */
export function pylonExpress(pylon: Pylon, options?: PylonExpressOptions): RequestHandler {
  const isShadow = options?.shadow ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    // ---------------------------------------------------------------
    // 1. Normalize Express request components to plain string records
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
    // 2. Run the Pylon request pipeline
    // ---------------------------------------------------------------

    pylon
      .processRequest(headers, req.path, query, req.body, {
        endpoint: options?.endpoint,
      })
      .then((processResult) => {
        // 3. Store version information on the request
        req.pylonClientVersion = processResult.version;

        const transformsApplied = processResult.debug?.transformsApplied ?? [];
        req.pylonTransformInfo = {
          transformsApplied,
          debugInfo: processResult.debug,
        };

        // 4. Replace the request body with the Pylon-transformed version
        if (!isShadow && processResult.body !== undefined) {
          req.body = processResult.body;
        }

        // ---------------------------------------------------------------
        // 5. Monkey-patch response methods
        // ---------------------------------------------------------------

        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        const originalEnd = res.end.bind(res);

        let intercepted = false;

        /** Restore the original response methods. */
        const restore = (): void => {
          res.json = originalJson;
          res.send = originalSend;
          res.end = originalEnd;
        };

        /**
         * Transform a response body through Pylon and send it via the
         * original method. Only the first call is honoured; subsequent
         * calls are passed through directly.
         */
        const sendTransformed = (body: unknown, sendOriginal: (b: unknown) => Response): void => {
          if (intercepted) return;
          intercepted = true;

          if (isShadow) {
            restore();
            sendOriginal(body);
            return;
          }

          pylon
            .processResponse(
              processResult.version,
              body,
              {},
              transformsApplied,
              processResult.debug,
            )
            .then((responseResult) => {
              // Set Pylon version/transform headers
              if (!res.headersSent) {
                for (const [headerKey, headerValue] of Object.entries(responseResult.headers)) {
                  res.set(headerKey, headerValue);
                }
              }

              restore();

              // If Pylon returned an error body, set 422 status
              if (
                !res.headersSent &&
                typeof responseResult.body === 'object' &&
                responseResult.body !== null &&
                'error' in responseResult.body
              ) {
                res.status(422);
              }

              sendOriginal(responseResult.body ?? body);
            })
            .catch(() => {
              // Response transform failed — fall through with the
              // untransformed body
              restore();
              sendOriginal(body);
            });
        };

        // Override res.json
        res.json = (body?: unknown): Response => {
          if (!intercepted) {
            sendTransformed(body, (b) => originalJson.call(res, b));
          }
          return res;
        };

        // Override res.send
        res.send = (body?: unknown): Response => {
          if (!intercepted) {
            sendTransformed(body, (b) => originalSend.call(res, b));
          }
          return res;
        };

        // Override res.end — Express 5 has three overloads (callback-only,
        // chunk+callback, chunk+encoding+callback), so we use a rest
        // signature that accepts all of them.
        res.end = (...args: any[]): Response => {
          if (!intercepted) {
            const [data] = args;

            // Only intercept when a non-trivial body is provided;
            // skip for callbacks and bare end() calls.
            const shouldIntercept =
              data !== undefined && data !== null && typeof data !== 'function';

            if (shouldIntercept) {
              sendTransformed(data, (b) => {
                // Pass the transformed body while preserving any
                // additional arguments (encoding, callback, etc.)
                const rest: unknown[] = args.slice(1);
                if (rest.length > 0) {
                  return (originalEnd as Function)(b, ...rest);
                }
                return (originalEnd as Function)(b);
              });
            } else {
              restore();
              (originalEnd as Function)(...args);
            }
          }
          return res;
        };

        // Safety net: restore originals if the response finishes without
        // interception (e.g. res.write + res.end directly)
        res.once('finish', restore);
        res.once('close', restore);

        // 6. Continue to the next middleware / route handler
        next();
      })
      .catch((err: unknown) => {
        next(err instanceof Error ? err : new Error(String(err)));
      });
  };
}

// ---------------------------------------------------------------
// Type augmentation — Express.Request
// ---------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      /**
       * The API version detected by Pylon for the current request.
       *
       * Set by `pylonExpress()` middleware after successful version
       * detection. Downstream middleware and route handlers can read
       * this to make version-specific decisions.
       */
      pylonClientVersion?: string;

      /**
       * Debug / audit information about the transforms Pylon applied.
       *
       * Populated by `pylonExpress()` middleware. The `transformsApplied`
       * array lists the transform chain (e.g. `['v1->v2', 'v2->v3']`)
       * and `debugInfo` contains the full Pylon DebugInfo object when
       * debug mode is enabled in the Pylon config.
       */
      pylonTransformInfo?: {
        transformsApplied: string[];
        debugInfo?: any;
      };
    }
  }
}

// Re-export the shadow middleware so consumers can import it from
// the same package without additional configuration.
export { pylonExpressShadow } from './shadow.js';
