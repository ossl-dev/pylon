import type { Server } from 'node:http';
import type { PylonConfig } from '@ossl/pylon-core';
import { defineEndpoint, Pylon } from '@ossl/pylon-core';
import { pylonExpress } from '@ossl/pylon-express';
import { pylonFastify } from '@ossl/pylon-fastify';
import { pylonHono } from '@ossl/pylon-hono';
import { pylonKoa } from '@ossl/pylon-koa';
import { pylonNext } from '@ossl/pylon-next';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import Koa from 'koa';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

type Mode = 'json' | 'text' | 'empty' | 'application-error';
interface Client {
  send(version: string, body: unknown): Promise<Response>;
  calls(): number;
}
type Adapter = (pylon: Pylon, mode?: Mode, endpoint?: string) => Promise<Client>;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function httpClient(server: Server, calls: () => number): Promise<Client> {
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const url = `http://127.0.0.1:${address.port}/users`;
  return {
    calls,
    send: (version, body) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-version': version },
        body: JSON.stringify(body),
      }),
  };
}

const adapters: Record<string, Adapter> = {
  Express: async (pylon, mode = 'json', endpoint) => {
    const app = express();
    let calls = 0;
    app.use(express.json());
    app.use(pylonExpress(pylon, { endpoint }));
    app.post('/users', (req, res) => {
      calls++;
      if (mode === 'text') res.type('text/plain').send('hello');
      else if (mode === 'empty') res.status(204).end();
      else if (mode === 'application-error') res.status(409).json({ error: 'conflict' });
      else res.json({ ...req.body, id: 1 });
    });
    return httpClient(new (await import('node:http')).Server(app), () => calls);
  },
  Fastify: async (pylon, mode = 'json', endpoint) => {
    const app = Fastify();
    let calls = 0;
    cleanup.push(() => app.close());
    await app.register(pylonFastify, { pylon, endpoint });
    app.post('/users', (req, reply) => {
      calls++;
      if (mode === 'text') return reply.type('text/plain').send('hello');
      if (mode === 'empty') return reply.code(204).send();
      if (mode === 'application-error') return reply.code(409).send({ error: 'conflict' });
      return reply.send({ ...(req.body as object), id: 1 });
    });
    return {
      calls: () => calls,
      send: async (version, body) => {
        const response = await app.inject({
          method: 'POST',
          url: '/users',
          headers: { 'api-version': version },
          payload: body as object,
        });
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(key, String(value));
        }
        return new Response(response.statusCode === 204 ? null : response.body, {
          status: response.statusCode,
          headers,
        });
      },
    };
  },
  Hono: async (pylon, mode = 'json', endpoint) => {
    const app = new Hono();
    let calls = 0;
    app.use('*', pylonHono(pylon, { endpoint }));
    app.post('/users', async (c) => {
      calls++;
      if (mode === 'text') return c.text('hello');
      if (mode === 'empty') return c.body(null, 204);
      if (mode === 'application-error') return c.json({ error: 'conflict' }, 409);
      return c.json({ ...(await c.req.json()), id: 1 });
    });
    return {
      calls: () => calls,
      send: async (version, body) =>
        app.request('/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-version': version },
          body: JSON.stringify(body),
        }),
    };
  },
  Koa: async (pylon, mode = 'json', endpoint) => {
    const app = new Koa();
    let calls = 0;
    app.use(async (ctx, next) => {
      let text = '';
      for await (const chunk of ctx.req) text += chunk;
      (ctx.request as unknown as { body: unknown }).body = JSON.parse(text);
      await next();
    });
    app.use(pylonKoa(pylon, { endpoint }));
    app.use((ctx) => {
      calls++;
      if (mode === 'text') ctx.body = 'hello';
      else if (mode === 'empty') ctx.status = 204;
      else if (mode === 'application-error') {
        ctx.body = { error: 'conflict' };
        ctx.status = 409;
      } else ctx.body = { ...(ctx.request as unknown as { body: object }).body, id: 1 };
    });
    return httpClient(new (await import('node:http')).Server(app.callback()), () => calls);
  },
  Next: async (pylon, mode = 'json', endpoint) => {
    let calls = 0;
    const handler = pylonNext(pylon, { endpoint })(async (request: Request) => {
      calls++;
      if (mode === 'text')
        return new Response('hello', { headers: { 'content-type': 'text/plain' } });
      if (mode === 'empty') return new Response(null, { status: 204 });
      if (mode === 'application-error')
        return Response.json({ error: 'conflict' }, { status: 409 });
      return Response.json({ ...(await request.json()), id: 1 });
    });
    return {
      calls: () => calls,
      send: (version, body) =>
        handler(
          new Request('http://localhost/users', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'api-version': version },
            body: JSON.stringify(body),
          }),
        ),
    };
  },
};

function createPylon(overrides: Partial<PylonConfig> = {}) {
  return new Pylon({
    current: 'v2',
    versions: { format: 'semantic' },
    schemas: { v1: z.object({ name: z.string() }), v2: z.object({ fullName: z.string() }) },
    transforms: {
      'v1->v2': {
        request: (input: { name: string }) => ({ fullName: input.name }),
        response: (input: { fullName: string; id: number }) => ({
          name: input.fullName,
          id: input.id,
        }),
      },
    },
    versioning: { sources: [{ type: 'header', name: 'api-version' }] },
    ...overrides,
  });
}

for (const [name, adapter] of Object.entries(adapters)) {
  describe(`${name} adapter contract`, () => {
    it('upgrades requests and downgrades responses through public registration', async () => {
      const client = await adapter(createPylon());
      const response = await client.send('v1', { name: 'Ada' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ name: 'Ada', id: 1 });
      expect(response.headers.get('x-api-version')).toBe('v2');
      expect(client.calls()).toBe(1);
    });

    it('adds version headers for current-version responses', async () => {
      const client = await adapter(createPylon());
      const response = await client.send('v2', { fullName: 'Ada' });
      expect(await response.json()).toEqual({ fullName: 'Ada', id: 1 });
      expect(response.headers.get('x-api-version')).toBe('v2');
    });

    it('rejects unknown versions before invoking the controller', async () => {
      const client = await adapter(createPylon());
      const response = await client.send('v99', { fullName: 'Ada' });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error.code', 'INVALID_API_VERSION');
      expect(client.calls()).toBe(0);
    });

    it('rejects invalid request bodies before invoking the controller', async () => {
      const client = await adapter(createPylon());
      const response = await client.send('v2', { fullName: 123 });
      expect(response.status).toBe(422);
      expect(await response.json()).toHaveProperty('error.code', 'VALIDATION_ERROR');
      expect(client.calls()).toBe(0);
    });

    it('rejects unpublished versions with 410', async () => {
      const pylon = createPylon();
      const client = await adapter(pylon);
      await pylon.rollback('v1', { fallback: 'v2', reason: 'retired', mode: 'reject' });
      const response = await client.send('v1', { name: 'Ada' });
      expect(response.status).toBe(410);
      expect(client.calls()).toBe(0);
    });

    it('returns 500 for a request transform bug', async () => {
      const client = await adapter(
        createPylon({
          schemas: { v2: z.unknown() },
          transforms: {
            'v1->v2': {
              request: () => {
                throw new Error('broken');
              },
            },
          },
        }),
      );
      const response = await client.send('v1', { name: 'Ada' });
      expect(response.status).toBe(500);
      expect(client.calls()).toBe(0);
    });

    it('does not leak the current response after a response transform bug', async () => {
      const client = await adapter(
        createPylon({
          transforms: {
            'v1->v2': {
              request: (input) => ({ fullName: input.name }),
              response: () => {
                throw new Error('broken');
              },
            },
          },
        }),
      );
      const response = await client.send('v1', { name: 'Ada' });
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty('error.code', 'RESPONSE_TRANSFORM_FAILED');
    });

    it('preserves text and empty responses', async () => {
      const pylon = createPylon();
      const text = await adapter(pylon, 'text');
      const response = await text.send('v1', { name: 'Ada' });
      expect(await response.text()).toBe('hello');
      const empty = await adapter(pylon, 'empty');
      const emptyResponse = await empty.send('v1', { name: 'Ada' });
      expect(emptyResponse.status).toBe(204);
      expect(await emptyResponse.text()).toBe('');
    });

    it('applies endpoint overrides while retaining global response transforms and rollback state', async () => {
      const pylon = createPylon({
        endpoints: {
          users: {
            transforms: {
              'v1->v2': { request: (input) => ({ fullName: input.name.toUpperCase() }) },
            },
          },
        },
      });
      const client = await adapter(pylon, 'json', 'users');
      expect(await (await client.send('v1', { name: 'Ada' })).json()).toEqual({
        name: 'ADA',
        id: 1,
      });
      await pylon.rollback('v1', { fallback: 'v2', reason: 'retired', mode: 'reject' });
      expect((await client.send('v1', { name: 'Ada' })).status).toBe(410);
    });

    it('preserves application error status codes', async () => {
      const client = await adapter(createPylon(), 'application-error');
      expect((await client.send('v2', { fullName: 'Ada' })).status).toBe(409);
    });

    function contracts(response = z.object({ fullName: z.string(), id: z.number() })) {
      const users = defineEndpoint({
        method: 'POST',
        path: '/users',
        contracts: {
          v1: {
            request: z.object({ name: z.string() }),
            response: z.object({ name: z.string(), id: z.number() }),
          },
          v2: { request: z.object({ fullName: z.string() }), response },
        },
        transforms: {
          'v1->v2': {
            request: (input) => ({ fullName: input.name }),
            response: (output) => ({ name: output.fullName, id: output.id }),
          },
        },
      });
      return new Pylon({ current: 'v2', versions: ['v1', 'v2'], endpoints: { users } });
    }

    it('automatically selects endpoint contracts and preserves lossy historical responses', async () => {
      const client = await adapter(contracts());
      expect(await (await client.send('v1', { name: 'Ada' })).json()).toEqual({
        name: 'Ada',
        id: 1,
      });
      expect(await (await client.send('v2', { fullName: 'Ada' })).json()).toEqual({
        fullName: 'Ada',
        id: 1,
      });
    });

    it('validates old input before invoking controller', async () => {
      const client = await adapter(contracts());
      const response = await client.send('v1', { name: 123 });
      expect(response.status).toBe(422);
      expect(client.calls()).toBe(0);
    });

    it.each(['v1', 'v2'])('validates successful controller output for %s', async (version) => {
      const client = await adapter(
        contracts(z.object({ fullName: z.string(), id: z.number().min(10) })),
      );
      const response = await client.send(
        version,
        version === 'v1' ? { name: 'Ada' } : { fullName: 'Ada' },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty('error.code', 'RESPONSE_TRANSFORM_FAILED');
    });

    it('preserves application errors and 204 responses with contracts enabled', async () => {
      const client = await adapter(contracts(), 'application-error');
      const response = await client.send('v1', { name: 'Ada' });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'conflict' });
      const empty = await adapter(contracts(), 'empty');
      expect((await empty.send('v1', { name: 'Ada' })).status).toBe(204);
    });
  });
}
