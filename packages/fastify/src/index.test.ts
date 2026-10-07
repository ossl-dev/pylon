import { Pylon } from '@ossl/pylon-core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pylonFastify } from './index.js';

function createTestPylon(): Pylon {
  const v2toV3Req = (r: any) => ({
    fullName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
    address: { street: r.address_line_1 ?? '', city: r.city ?? '' },
  });
  const v3toV2Res = (r: any) => ({
    first_name: (r.fullName ?? '').split(' ')[0] ?? '',
    last_name: (r.fullName ?? '').split(' ').slice(1).join(' ') ?? '',
    address_line_1: r.address?.street ?? '',
    city: r.address?.city ?? '',
  });
  const v3toV4Req = (r: any) => ({
    fullName: r.fullName ?? '',
    address: { street: r.address?.street ?? '', city: r.address?.city ?? '', country: 'US' },
    email: r.email ?? 'unknown@example.com',
  });
  const v4toV3Res = (r: any) => ({
    fullName: r.fullName ?? '',
    address: { street: r.address?.street ?? '', city: r.address?.city ?? '' },
  });
  return new Pylon({
    current: 'v4',
    defaultVersion: 'v4',
    versions: [
      { name: 'v2', order: 1 },
      { name: 'v3', order: 2 },
      { name: 'v4', order: 3 },
    ],
    schemas: {
      v2: z.object({ name: z.string(), address_line_1: z.string(), city: z.string() }),
      v3: z.object({
        fullName: z.string(),
        address: z.object({ street: z.string(), city: z.string() }),
      }),
      v4: z.object({
        fullName: z.string(),
        address: z.object({
          street: z.string(),
          city: z.string(),
          country: z.string().default('US'),
        }),
        email: z.string().email().default('unknown@example.com'),
      }),
    },
    transforms: {
      'v2->v3': { request: v2toV3Req, response: v3toV2Res },
      'v3->v4': { request: v3toV4Req, response: v4toV3Res },
    },
    versioning: {
      sources: [{ type: 'header', name: 'X-API-Version' }],
      headers: { apiVersion: true, deprecation: true, debug: 'always' },
    },
    debug: { enabled: true },
  });
}

describe('pylonFastify', () => {
  const v4Payload = {
    fullName: 'John Doe',
    address: { street: '123 Main St', city: 'SF', country: 'US' },
    email: 'john@example.com',
  };

  const v2Payload = {
    first_name: 'John',
    last_name: 'Doe',
    address_line_1: '123 Main St',
    city: 'SF',
  };

  it('passes through v4 request without transform', async () => {
    const fastify = Fastify();
    const pylon = createTestPylon();
    await fastify.register(pylonFastify, { pylon });

    fastify.post('/users', async (req, _reply) => {
      return { ...(req.body as object), id: 1 };
    });

    await fastify.ready();

    const res = await fastify.inject({
      method: 'POST',
      url: '/users',
      payload: v4Payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('email', 'john@example.com');
    expect(body).toHaveProperty('id', 1);

    await fastify.close();
  });

  it('handles v2 request end to end', async () => {
    const fastify = Fastify();
    const pylon = createTestPylon();
    await fastify.register(pylonFastify, { pylon });

    fastify.post('/users', async (_req, _reply) => {
      return { ok: true };
    });

    await fastify.ready();

    const res = await fastify.inject({
      method: 'POST',
      url: '/users',
      headers: { 'X-API-Version': 'v2' },
      payload: v2Payload,
    });

    expect(res.statusCode).toBe(200);

    await fastify.close();
  });

  it('handles v4 request end to end', async () => {
    const fastify = Fastify();
    const pylon = createTestPylon();
    await fastify.register(pylonFastify, { pylon });

    fastify.post('/users', async (_req, _reply) => {
      return { ok: true };
    });

    await fastify.ready();

    const res = await fastify.inject({
      method: 'POST',
      url: '/users',
      payload: v4Payload,
    });

    expect(res.statusCode).toBe(200);

    await fastify.close();
  });

  it('uses default version (v4) when no version header is sent', async () => {
    const fastify = Fastify();
    const pylon = createTestPylon();
    await fastify.register(pylonFastify, { pylon });

    fastify.post('/users', async (req, _reply) => {
      return { ...(req.body as object), id: 1 };
    });

    await fastify.ready();

    const res = await fastify.inject({
      method: 'POST',
      url: '/users',
      payload: v4Payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('id', 1);

    await fastify.close();
  });

  it('processResponse transforms v4 response body back to v2 shape', async () => {
    const pylon = createTestPylon();
    const v4Response = {
      fullName: 'John Doe',
      address: { street: '123 Main St', city: 'SF', country: 'US' },
      email: 'john@example.com',
    };

    const result = await pylon.processResponse('v2', v4Response, {}, ['v2->v3', 'v3->v4']);

    expect(result.body).toHaveProperty('first_name', 'John');
    expect(result.body).toHaveProperty('last_name', 'Doe');
    expect(result.body).toHaveProperty('address_line_1', '123 Main St');
    expect(result.body).toHaveProperty('city', 'SF');
    expect(result.body).not.toHaveProperty('email');

    const v4Result = await pylon.processResponse('v4', v4Response, {}, []);
    expect(v4Result.body).toEqual(v4Response);
  });
});
