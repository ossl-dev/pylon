import type { DebugInfo, Pylon } from '@ossl/pylon-core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface PylonExpressOptions {
  endpoint?: string;
  shadow?: boolean;
}

/** Express has no response hook; restore patched methods before writing any body. */
export function pylonExpress(pylon: Pylon, options?: PylonExpressOptions): RequestHandler {
  pylon = options?.endpoint ? pylon.forEndpoint(options.endpoint) : pylon;
  return (req: Request, res: Response, next: NextFunction): void => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') query[key] = value;
      else if (Array.isArray(value) && typeof value[0] === 'string') query[key] = value[0];
    }

    pylon
      .processRequest(headers, req.path, query, req.body, { endpoint: options?.endpoint })
      .then((result) => {
        for (const [key, value] of Object.entries(result.headers)) res.set(key, value);
        if (!options?.shadow && result.transformResult.status === 'error') {
          res.status(result.status ?? 422).json(result.body);
          return;
        }
        req.pylonClientVersion = result.version;
        req.pylonTransformInfo = {
          transformsApplied: result.debug?.transformsApplied ?? [],
          debugInfo: result.debug,
        };
        if (!options?.shadow) req.body = result.body;
        if (
          options?.shadow ||
          (result.version === pylon.current && !pylon.isUnpublished(result.version))
        ) {
          next();
          return;
        }

        const originalJson = res.json.bind(res);
        const originalSend = res.send.bind(res);
        const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
        let intercepted = false;
        const restore = () => {
          res.json = originalJson;
          res.send = originalSend;
          res.end = originalEnd;
        };
        const sendTransformed = (body: unknown, send: (body: unknown) => Response) => {
          if (intercepted) return;
          intercepted = true;
          pylon
            .processResponse(
              result.version,
              body,
              {},
              result.debug?.transformsApplied ?? [],
              result.debug,
            )
            .then((response) => {
              restore();
              if (!res.headersSent) {
                res.removeHeader('content-length');
                for (const [key, value] of Object.entries(response.headers)) res.set(key, value);
                if (response.status) res.status(response.status);
              }
              send(response.body);
            })
            .catch((error: unknown) => {
              restore();
              next(error instanceof Error ? error : new Error(String(error)));
            });
        };

        res.json = (body?: unknown): Response => {
          sendTransformed(body, originalJson);
          return res;
        };
        res.send = (body?: unknown): Response => {
          if (intercepted) return res;
          if (typeof body === 'string' || body instanceof Uint8Array) {
            if (!String(res.getHeader('content-type') ?? '').includes('json')) {
              restore();
              return originalSend(body);
            }
            try {
              body = JSON.parse(String(body));
            } catch {
              restore();
              return originalSend(body);
            }
          }
          sendTransformed(body, originalSend);
          return res;
        };
        res.end = (...args: unknown[]): Response => {
          if (intercepted) return res;
          const [data] = args;
          if (
            !res.headersSent &&
            (typeof data === 'string' || data instanceof Uint8Array) &&
            String(res.getHeader('content-type') ?? '').includes('json')
          ) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(String(data));
            } catch {
              restore();
              return originalEnd(...args);
            }
            sendTransformed(parsed, (body) => originalEnd(JSON.stringify(body), ...args.slice(1)));
            return res;
          }
          restore();
          return originalEnd(...args);
        };
        res.once('finish', restore);
        res.once('close', restore);
        next();
      })
      .catch((error: unknown) => next(error instanceof Error ? error : new Error(String(error))));
  };
}

declare global {
  namespace Express {
    interface Request {
      pylonClientVersion?: string;
      pylonTransformInfo?: { transformsApplied: string[]; debugInfo?: DebugInfo };
    }
  }
}

export { pylonExpressShadow } from './shadow.js';
