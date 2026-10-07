import type { DebugInfo, Pylon } from '@ossl/pylon-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export interface PylonFastifyOptions {
  /** Override endpoint name for per-endpoint config. */
  endpoint?: string;
}

/** @internal Per-request metadata carried between lifecycle hooks. */
interface RequestMeta {
  clientVersion: string;
  transformsApplied: string[];
  debug?: DebugInfo;
  pylonError: boolean;
}

const metaMap = new WeakMap<FastifyRequest, RequestMeta>();

/**
 * Fastify plugin for Pylon API versioning.
 *
 * Registers three lifecycle hooks:
 * - `preHandler` -- detect client version, transform request body to
 *   the current (canonical) version
 * - `onSend`     -- transform response body back to the client version
 * - `onResponse` -- clean up per-request state
 *
 * This is one of the cleanest adapter implementations because it
 * leverages Fastify's `onSend` hook for transparent response
 * interception without requiring custom serialisers.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify';
 * import { pylonFastify } from '@ossl/pylon-fastify';
 * import { Pylon } from '@ossl/pylon-core';
 *
 * const fastify = Fastify();
 * const pylon = new Pylon({ ... });
 *
 * await fastify.register(pylonFastify, { pylon });
 * await fastify.listen({ port: 3000 });
 * ```
 *
 * @param fastify - Target FastifyInstance
 * @param options - Plugin options (pylon instance + optional endpoint)
 * @param done    - Registration completion callback
 */
function pylonFastifyPlugin(
  fastify: FastifyInstance,
  options: { pylon: Pylon; endpoint?: string },
  done: (err?: Error) => void,
): void {
  const pylon = options.endpoint ? options.pylon.forEndpoint(options.endpoint) : options.pylon;
  const endpoint = options.endpoint;

  // ── preHandler ──────────────────────────────────────────────────
  // Intercept the incoming request, detect the API version the client
  // wants, transform the body to the current (canonical) version, and
  // store metadata so that onSend can reverse the transform on the
  // response.
  //
  // preHandler is used instead of onRequest because Fastify does not
  // parse the request body until after the onRequest phase.
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await pylon.processRequest(
        request.headers as Record<string, string>,
        request.url,
        request.query as Record<string, string>,
        request.body,
        endpoint ? { endpoint } : undefined,
      );

      const isError = result.transformResult.status === 'error';

      metaMap.set(request, {
        clientVersion: result.version,
        transformsApplied: result.debug?.transformsApplied ?? [],
        debug: result.debug,
        pylonError: isError,
      });

      if (isError) {
        for (const [key, value] of Object.entries(result.headers)) {
          void reply.header(key, value);
        }
        void reply.code(result.status ?? 400).send(result.body);
        return;
      }

      for (const [key, value] of Object.entries(result.headers)) void reply.header(key, value);

      // Replace the body so the route handler receives data in the
      // current version's shape.
      request.body = result.body;
    } catch {
      void reply.code(500).send({
        error: 'pylon-fastify: internal error during request processing',
      });
    }
  });

  // ── onSend ─────────────────────────────────────────────────────
  // Before the payload is serialised, reverse the version transform
  // so the client receives data in the shape they requested.
  fastify.addHook(
    'onSend',
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const meta = metaMap.get(request);
      if (!meta || meta.pylonError) {
        return;
      }

      // Only intercept serialised JSON payloads.
      if (typeof payload !== 'string') {
        return;
      }

      try {
        const parsed = JSON.parse(payload) as unknown;

        const result = await pylon.processResponse(
          meta.clientVersion,
          parsed,
          {},
          meta.transformsApplied,
          meta.debug,
        );

        for (const [key, value] of Object.entries(result.headers)) {
          void reply.header(key, value);
        }

        if (result.status) void reply.code(result.status);
        reply.removeHeader('content-length');
        return JSON.stringify(result.body);
      } catch {
        // Graceful degradation: send the current-version payload.
        return payload;
      }
    },
  );

  // ── onResponse ────────────────────────────────────────────────
  // Tear down per-request metadata once the response has been sent.
  fastify.addHook('onResponse', async (request: FastifyRequest, _reply: FastifyReply) => {
    metaMap.delete(request);
  });

  done();
}

export const pylonFastify = fp(pylonFastifyPlugin, { name: 'pylon-fastify', fastify: '5.x' });
