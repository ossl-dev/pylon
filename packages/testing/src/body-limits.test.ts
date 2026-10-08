import { type JSONBodyLimits, Pylon } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { pylonNext } from '@ossl/pylon-next';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Handler = (request: Request) => Response | Promise<Response>;
const adapters = {
  Hono: (pylon: Pylon, handler: Handler, bodyLimits?: JSONBodyLimits) => {
    const app = new Hono();
    app.use('*', pylonHono(pylon, { bodyLimits }));
    app.post('/users', async (c) =>
      handler(
        new Request(c.req.url, {
          method: 'POST',
          headers: c.req.raw.headers,
          body: await c.req.text(),
        }),
      ),
    );
    return (request: Request) => app.fetch(request);
  },
  Next: (pylon: Pylon, handler: Handler, bodyLimits?: JSONBodyLimits) =>
    pylonNext(pylon, { bodyLimits })(handler),
};
function config(request = (input: unknown) => input, response = (input: unknown) => input) {
  return new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    endpoints: {
      users: {
        method: 'POST',
        path: '/users',
        contracts: {
          v1: { request: z.unknown(), response: z.unknown() },
          v2: { request: z.unknown(), response: z.unknown() },
        },
        transforms: { 'v1->v2': { request, response } },
      },
    },
  });
}
function request(body: BodyInit, extra: Record<string, string> = {}) {
  return new Request('http://localhost/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-version': 'v1', ...extra },
    body,
    duplex: 'half',
  } as RequestInit);
}
for (const [name, adapter] of Object.entries(adapters)) {
  describe(`${name} body limits`, () => {
    it('rejects oversized chunked requests before invoking migrations or handlers', async () => {
      const migration = vi.fn((input) => input);
      const handler = vi.fn(() => Response.json('ok'));
      const send = adapter(config(migration), handler, { request: 4 });
      const response = await send(
        request(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('"12345"'));
              c.close();
            },
          }),
        ),
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toHaveProperty('error.code', 'REQUEST_BODY_TOO_LARGE');
      expect(migration).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it('allows exact UTF-8 budgets and preserves raw unchanged JSON', async () => {
      const raw = '  "💤" ';
      const send = adapter(config(), async (req) => Response.json(await req.text()), {
        request: new TextEncoder().encode(raw).length,
        response: 100,
      });
      const response = await send(request(raw));
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(raw);
    });

    it('returns 500 for oversized handler responses before running migrations', async () => {
      const migration = vi.fn((input) => input);
      const send = adapter(config(undefined, migration), () => Response.json('12345'), {
        response: 4,
      });
      const response = await send(request('null'));
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty('error.code', 'RESPONSE_BODY_TOO_LARGE');
      expect(migration).not.toHaveBeenCalled();
    });

    it('rejects response expansion after migration', async () => {
      const send = adapter(
        config(undefined, () => '12345'),
        () => Response.json('a'),
        { response: 4 },
      );
      const response = await send(request('null'));
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty('error.code', 'RESPONSE_BODY_TOO_LARGE');
    });

    it('actually removes request bodies when migration returns undefined', async () => {
      const send = adapter(
        config(() => undefined),
        async (req) => Response.json(await req.text()),
      );
      const response = await send(request('"old"'));
      expect(response.status).toBe(200);
      expect(await response.json()).toBe('');
    });

    it('keeps non-JSON streams outside JSON budgets', async () => {
      const send = adapter(
        new Pylon({ current: 'v1' }),
        (req) =>
          new Response(req.body, { headers: { 'content-type': 'application/octet-stream' } }),
        { request: 1, response: 1 },
      );
      const response = await send(
        request('binary payload', { 'content-type': 'application/octet-stream' }),
      );
      expect(await response.text()).toBe('binary payload');
    });
  });
}

it('preserves Hono body caches populated by earlier middleware', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await c.req.json();
    await next();
  });
  app.use('*', pylonHono(new Pylon({ current: 'v1' })));
  app.post('/users', async (c) => c.json(await c.req.json()));
  const response = await app.fetch(request('{"name":"Ada"}'));
  expect(await response.json()).toEqual({ name: 'Ada' });
});
