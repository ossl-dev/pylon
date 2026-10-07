import type { Pylon } from '@ossl/pylon-core';
import type { NextRequest } from 'next/server';

export interface PylonNextOptions {
  /** Optional endpoint name for scoped versioning via pylon.forEndpoint(). */
  endpoint?: string;
}

/**
 * Wrap a Next.js App Router route handler with Pylon API version transforms.
 *
 * The wrapper:
 * 1. Extracts version from request headers / URL / query / body via `pylon.processRequest`
 * 2. Transforms the request body from the client's version to the current version
 * 3. Creates a new `Request` with the transformed body for the handler
 * 4. Intercepts the handler's `Response` and transforms it back to the client version
 * 5. Injects API versioning headers (`X-API-Version`, `Deprecation`, `Sunset`, etc.)
 *
 * @example
 * ```ts
 * import { Pylon } from '@ossl/pylon-core';
 * import { pylonNext } from '@ossl/pylon-next';
 *
 * const pylon = new Pylon({
 *   current: 'v2',
 *   schemas: { v1: v1Schema, v2: v2Schema },
 *   transforms: { 'v1->v2': { request: up, response: down } },
 * });
 *
 * // App Router route handler
 * export const POST = pylonNext(pylon)(async (request) => {
 *   const data = await request.json();        // already on current version
 *   return Response.json({ result: data });   // transformed back to client version
 * });
 * ```
 */
export function pylonNext(pylon: Pylon, options?: PylonNextOptions) {
  // biome-ignore lint/suspicious/noExplicitAny: decorator wrapping unknown handler signatures
  return function wrap<T extends (...args: any[]) => any>(handler: T): T {
    // biome-ignore lint/suspicious/noExplicitAny: args[0] is narrowed to NextRequest below
    return (async (...args: any[]) => {
      const request = args[0] as NextRequest | undefined;
      if (!request || !(request instanceof Request)) {
        return handler(...args);
      }

      // --- Extract request metadata ---
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const url = new URL(request.url);
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      // Parse JSON body if present; otherwise leave undefined so Pylon
      // does not attempt to transform a non-JSON payload.
      let body: unknown;
      if (request.body) {
        try {
          body = await request.clone().json();
        } catch {
          // Not JSON (FormData, plain text, etc.) — body stays undefined
        }
      }

      // --- Process request through Pylon ---
      const result = await pylon.processRequest(headers, url.pathname, query, body, {
        endpoint: options?.endpoint,
      });

      const clientVersion = result.version;

      // Error from transform pipeline → return Pylon error response
      if (result.transformResult.status === 'error' && result.transformResult.error) {
        const statusCode = result.transformResult.error.code === 'VERSION_UNPUBLISHED' ? 410 : 422;
        return Response.json(result.transformResult.error, {
          status: statusCode,
          headers: result.headers,
        });
      }

      // --- Create transformed request for downstream handler ---
      const transformedRequest = createTransformedRequest(request, result.body);

      // --- Invoke the original route handler ---
      const response = await handler(transformedRequest, ...args.slice(1));

      // If the handler returned something other than a Response, pass through
      // (e.g. a redirect `NextResponse.redirect()`, or a plain value).
      if (!(response instanceof Response)) {
        return response;
      }

      // --- Response phase: transform back to client version ---
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (clientVersion !== pylon.current) {
        // Only attempt JSON transformation when the response is actually JSON
        const contentType = responseHeaders['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          const responseBody = await response.clone().json();
          const responseResult = await pylon.processResponse(
            clientVersion,
            responseBody,
            responseHeaders,
            result.debug?.transformsApplied ?? [],
            result.debug,
          );
          return new Response(JSON.stringify(responseResult.body), {
            status: response.status,
            statusText: response.statusText,
            headers: { ...responseHeaders, ...responseResult.headers },
          });
        }

        // Non-JSON response body — pass through, just add Pylon headers
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: { ...responseHeaders, ...result.headers },
        });
      }

      // Same version: pass through unchanged, just merge Pylon headers
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: { ...responseHeaders, ...result.headers },
      });
    }) as T;
  };
}

/**
 * Build a new `Request` from the original request, replacing the body
 * with the Pylon-transformed payload when applicable.
 *
 * Preserves the original method, URL, and headers. For GET/HEAD or when
 * no parsed body existed (non-JSON), the original body stream is passed
 * through as-is.
 */
function createTransformedRequest(original: NextRequest, transformedBody: unknown): NextRequest {
  const { method } = original;

  // GET/HEAD should never carry a body; when no JSON body was parsed
  // (transformedBody === undefined), pass the original stream through.
  const body =
    ['GET', 'HEAD'].includes(method) || transformedBody === undefined
      ? undefined
      : JSON.stringify(transformedBody);

  return new Request(original.url, {
    method,
    headers: original.headers,
    body,
  }) as unknown as NextRequest;
}
