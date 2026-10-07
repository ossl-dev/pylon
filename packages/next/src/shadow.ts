import type { Pylon } from '@ossl/pylon-core';
import type { NextRequest } from 'next/server';

export interface PylonNextShadowOptions {
  /** Optional endpoint name for scoped versioning via pylon.forEndpoint(). */
  endpoint?: string;
}

/**
 * Shadow-mode wrapper for Next.js App Router route handlers.
 *
 * Logs version detection and transform results without modifying the
 * request or response. Use this to observe what Pylon _would_ do before
 * turning on actual transformation.
 *
 * @example
 * ```ts
 * import { Pylon } from '@ossl/pylon-core';
 * import { pylonNextShadow } from '@ossl/pylon-next';
 *
 * const pylon = new Pylon({ ... });
 *
 * export const GET = pylonNextShadow(pylon)(async (request) => {
 *   // handler runs unmodified; shadow logs go to stdout
 *   return Response.json({ ... });
 * });
 * ```
 */
export function pylonNextShadow(pylon: Pylon, options?: PylonNextShadowOptions) {
  // biome-ignore lint/suspicious/noExplicitAny: decorator wrapping unknown handler signatures
  return function wrap<T extends (...args: any[]) => any>(handler: T): T {
    // biome-ignore lint/suspicious/noExplicitAny: args[0] is narrowed to NextRequest below
    return (async (...args: any[]) => {
      const request = args[0] as NextRequest | undefined;
      if (!request || !(request instanceof Request)) {
        return handler(...args);
      }

      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const url = new URL(request.url);
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      let body: unknown;
      if (request.body) {
        try {
          body = await request.clone().json();
        } catch {
          // Not JSON
        }
      }

      // Await processing so the log output is deterministic relative to the
      // request lifecycle.
      const result = await pylon.processRequest(headers, url.pathname, query, body, {
        endpoint: options?.endpoint,
      });

      console.log(`[pylon:shadow] ${request.method} ${url.pathname}`);
      console.log(`[pylon:shadow] Detected version: ${result.version}`);
      console.log(`[pylon:shadow] Current version:   ${pylon.current}`);
      if (result.debug && result.debug.transformsApplied.length > 0) {
        console.log(`[pylon:shadow] Transforms:  ${result.debug.transformsApplied.join(' -> ')}`);
      }
      console.log(`[pylon:shadow] Transform status: ${result.transformResult.status}`);

      // Call the original handler without any modification
      return handler(...args);
    }) as T;
  };
}
