import { Pylon } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { pylonNext } from '@ossl/pylon-next';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type Handler = (body: unknown) => Response;
function pylon() {
  return new Pylon({
    current: 'v2',
    versions: ['v1', 'v2'],
    endpoints: {
      users: {
        method: 'POST',
        path: '/users',
        contracts: {
          v1: { request: z.null(), response: z.null() },
          v2: { request: z.string(), response: z.string() },
        },
        transforms: { 'v1->v2': { request: () => 'created', response: () => null } },
      },
    },
  });
}
const adapters = {
  Hono: (handler: Handler) => {
    const app = new Hono();
    app.use('*', pylonHono(pylon()));
    app.post('/users', async (c) => handler(await c.req.json()));
    return (request: Request) => app.fetch(request);
  },
  Next: (handler: Handler) =>
    pylonNext(pylon())(async (request: Request) => handler(await request.json())),
};

for (const [name, adapter] of Object.entries(adapters)) {
  describe(`${name} HTTP boundaries`, () => {
    it('migrates valid null payloads and preserves structured JSON media types', async () => {
      const handler = vi.fn((body) => Response.json(body));
      const response = await adapter(handler)(
        new Request('http://localhost/users', {
          method: 'POST',
          headers: {
            'content-type': 'Application/vnd.test+json; charset=utf-8',
            'api-version': 'v1',
          },
          body: 'null',
        }),
      );
      expect(handler).toHaveBeenCalledWith('created');
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    });

    it('rejects malformed JSON before controller execution', async () => {
      const handler = vi.fn(() => Response.json('created'));
      const response = await adapter(handler)(
        new Request('http://localhost/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-version': 'v1' },
          body: '{',
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error.code', 'INVALID_JSON');
      expect(handler).not.toHaveBeenCalled();
    });

    it('keeps separate cookies and removes obsolete content length after rewriting', async () => {
      const headers = new Headers({
        'content-type': 'application/vnd.test+json',
        'content-length': '9',
      });
      headers.append('set-cookie', 'a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT');
      headers.append('set-cookie', 'b=2; HttpOnly');
      const response = await adapter(() => new Response('"created"', { headers }))(
        new Request('http://localhost/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-version': 'v1' },
          body: 'null',
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(response.headers.get('content-length')).toBeNull();
      expect(await response.json()).toBeNull();
    });

    it('rejects malformed JSON responses with a consistent server error', async () => {
      const response = await adapter(
        () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      )(
        new Request('http://localhost/users', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'api-version': 'v2' },
          body: '"created"',
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty('error.code', 'RESPONSE_TRANSFORM_FAILED');
    });
  });
}

it('preserves non-JSON request and response streams', async () => {
  const input = new Uint8Array([0, 1, 128, 255]);
  const app = new Hono();
  app.use('*', pylonHono(new Pylon({ current: 'v1' })));
  app.post(
    '/upload',
    async (c) =>
      new Response(await c.req.arrayBuffer(), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  );
  const next = pylonNext(new Pylon({ current: 'v1' }))(
    async (request: Request) =>
      new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } }),
  );
  for (const send of [(req: Request) => app.fetch(req), next]) {
    const response = await send(
      new Request('http://localhost/upload', {
        method: 'POST',
        body: input,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(input);
  }
});
