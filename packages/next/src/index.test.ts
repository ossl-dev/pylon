import { Pylon } from '@ossl/pylon-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pylonNext, pylonNextShadow } from './index.js';

// ---- helpers ----

function createTestPylon(overrides?: Partial<{ debug: boolean }>): Pylon {
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
    address: {
      street: r.address?.street ?? '',
      city: r.address?.city ?? '',
      country: 'US',
    },
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
      v2: z.object({
        name: z.string(),
        address_line_1: z.string(),
        city: z.string(),
      }),
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
    debug: { enabled: overrides?.debug ?? true },
  });
}

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

function makeRequest(
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Request {
  return new Request(`http://localhost${path}`, {
    method: options?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

// ============================================================
// pylonNext
// ============================================================

describe('pylonNext', () => {
  it('passes through v4 (current) request without transform', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (request: Request) => {
      const body = await request.json();
      return Response.json({ ...body, id: 1 });
    });

    const req = makeRequest('/users', { body: v4Payload });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('email', 'john@example.com');
    expect(body).toHaveProperty('id', 1);
  });

  it('handles v2 request end to end (upgrade request, downgrade response)', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (request: Request) => {
      // Body should already be transformed to v4 shape
      const body = await request.json();
      // Return the v4-shaped body directly so response transform applies cleanly
      return Response.json(body);
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Response downgraded to v2 shape (fullName→first_name/last_name, address→address_line_1/city)
    expect(body).toHaveProperty('first_name', 'John');
    expect(body).toHaveProperty('last_name', 'Doe');
    expect(body).toHaveProperty('address_line_1', '123 Main St');
    expect(body).toHaveProperty('city', 'SF');
    expect(body).not.toHaveProperty('email');
    expect(res.headers.get('X-API-Version')).toBe('v4');
  });

  it('sets X-API-Version and X-Pylon-Debug headers', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (_req: Request) => Response.json({ ok: true }));

    const req = makeRequest('/users', { body: v4Payload });
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-API-Version')).toBe('v4');
    expect(res.headers.get('X-Pylon-Debug')).toBe('enabled');
  });

  it('uses default version when no version header sent', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (request: Request) => {
      const body = await request.json();
      return Response.json({ ...body, id: 1 });
    });

    const req = makeRequest('/users', { body: v4Payload });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('id', 1);
  });

  it('transforms v2 request body to v4 shape for handler', async () => {
    const pylon = createTestPylon();
    let receivedBody: any;

    const handler = pylonNext(pylon)(async (request: Request) => {
      receivedBody = await request.json();
      return Response.json({ ok: true });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    await handler(req);

    expect(receivedBody).toHaveProperty('fullName', 'John Doe');
    expect(receivedBody).toHaveProperty('address');
    expect(receivedBody.address).toHaveProperty('street', '123 Main St');
    expect(receivedBody).not.toHaveProperty('first_name');
  });

  it('transforms v4 response back to v2 shape for v2 client', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (_req: Request) => {
      return Response.json({
        fullName: 'Jane Smith',
        address: { street: '456 Oak Ave', city: 'LA', country: 'US' },
        email: 'jane@example.com',
      });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('first_name', 'Jane');
    expect(body).toHaveProperty('last_name', 'Smith');
    expect(body).toHaveProperty('address_line_1', '456 Oak Ave');
    expect(body).toHaveProperty('city', 'LA');
    expect(body).not.toHaveProperty('email');
  });

  it('passes through non-Request first argument to handler', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (a: number, b: number) => a + b);

    const result = await handler(1, 2);
    expect(result).toBe(3);
  });

  it('passes through when first argument is undefined', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (...args: any[]) => args.length);

    const result = await handler();
    expect(result).toBe(0);
  });

  it('handles POST request with body available to handler', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (request: Request) => {
      const body = await request.json();
      return Response.json({ method: request.method, hasBody: !!body });
    });

    const req = makeRequest('/users', { method: 'POST', body: v4Payload });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.method).toBe('POST');
    expect(body.hasBody).toBe(true);
  });

  it('passes through non-JSON response unchanged for same version', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (_req: Request) => {
      return new Response('plain text', {
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const req = makeRequest('/users', { body: v4Payload });
    const res = await handler(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toBe('plain text');
    expect(res.headers.get('X-API-Version')).toBe('v4');
  });

  it('passes through non-JSON response for different version (headers only)', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (_req: Request) => {
      return new Response('plain text', {
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toBe('plain text');
    expect(res.headers.get('X-API-Version')).toBe('v4');
  });

  it('passes through non-Response handler return value', async () => {
    const pylon = createTestPylon();
    const handler = pylonNext(pylon)(async (_req: Request) => {
      return { custom: 'value', notAResponse: true };
    });

    const req = makeRequest('/users', { body: v4Payload });
    const result = await handler(req);

    expect(result).toEqual({ custom: 'value', notAResponse: true });
  });
});

// ============================================================
// pylonNextShadow
// ============================================================

describe('pylonNextShadow', () => {
  it('does not transform request body in shadow mode', async () => {
    const pylon = createTestPylon();
    let receivedBody: any;

    const handler = pylonNextShadow(pylon)(async (request: Request) => {
      receivedBody = await request.json();
      return Response.json({ ok: true });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    // Body should NOT be transformed
    expect(receivedBody).toHaveProperty('first_name', 'John');
    expect(receivedBody).toHaveProperty('last_name', 'Doe');
  });

  it('does not transform response in shadow mode', async () => {
    const pylon = createTestPylon();
    const handler = pylonNextShadow(pylon)(async (_req: Request) => {
      return Response.json({ fullName: 'Jane Smith', email: 'jane@example.com' });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Response should NOT be downgraded
    expect(body).toHaveProperty('fullName', 'Jane Smith');
    expect(body).toHaveProperty('email', 'jane@example.com');
  });

  it('calls original handler without modifying args', async () => {
    const pylon = createTestPylon();
    const originalReq = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    let receivedRequest: Request | undefined;
    const handler = pylonNextShadow(pylon)(async (request: Request) => {
      receivedRequest = request;
      return Response.json({ ok: true });
    });

    await handler(originalReq);

    // Shadow mode passes original request unchanged
    expect(receivedRequest).toBe(originalReq);
    // Original body preserved
    const body = await receivedRequest!.clone().json();
    expect(body).toHaveProperty('first_name', 'John');
  });
});

// ============================================================
// Error paths
// ============================================================

describe('pylonNext error handling', () => {
  it('returns 410 for unpublished version in reject mode', async () => {
    const pylon = createTestPylon();
    await pylon.rollback('v2', {
      reason: 'Security vulnerability',
      fallback: 'v4',
      mode: 'reject',
    });

    const handler = pylonNext(pylon)(async (_req: Request) => {
      return Response.json({ ok: true });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body).toHaveProperty('error.code', 'VERSION_UNPUBLISHED');
  });

  it('returns 500 for transform failure', async () => {
    const brokenPylon = new Pylon({
      current: 'v4',
      defaultVersion: 'v4',
      versions: [
        { name: 'v2', order: 1 },
        { name: 'v3', order: 2 },
        { name: 'v4', order: 3 },
      ],
      schemas: {
        v2: z.object({ name: z.string() }),
        v3: z.object({ name: z.string() }),
        v4: z.object({ name: z.string() }),
      },
      transforms: {
        'v2->v3': {
          request: () => {
            throw new Error('Transform exploded');
          },
        },
        'v3->v4': { request: (r: any) => r },
      },
      versioning: {
        sources: [{ type: 'header', name: 'X-API-Version' }],
      },
      debug: { enabled: false },
    });

    const handler = pylonNext(brokenPylon)(async (_req: Request) => {
      return Response.json({ ok: true });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v2' },
      body: { name: 'test' },
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toHaveProperty('error.code', 'EXECUTION_ERROR');
  });

  it('returns 422 for validation error', async () => {
    const strictPylon = new Pylon({
      current: 'v2',
      defaultVersion: 'v2',
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
      schemas: {
        v1: z.object({ count: z.number() }),
        v2: z.object({ count: z.number().min(10, 'Must be at least 10') }),
      },
      transforms: {
        'v1->v2': { request: (r: any) => ({ count: r.count }) },
      },
      versioning: {
        sources: [{ type: 'header', name: 'X-API-Version' }],
      },
      debug: { enabled: false },
    });

    const handler = pylonNext(strictPylon)(async (_req: Request) => {
      return Response.json({ ok: true });
    });

    const req = makeRequest('/users', {
      headers: { 'X-API-Version': 'v1' },
      body: { count: 5 },
    });
    const res = await handler(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });
});
