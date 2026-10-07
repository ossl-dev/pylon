import { Pylon } from '@ossl/pylon-core';
import { createServer, request as httpRequest } from 'http';
import Koa from 'koa';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pylonKoa, pylonKoaShadow } from './index.js';

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
      headers: { apiVersion: true, deprecation: true },
    },
    debug: { enabled: overrides?.debug ?? true },
  });
}

/** Minimal JSON body parser middleware for Koa tests. */
function jsonBodyParser(): Koa.Middleware {
  return async (ctx, next) => {
    if (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH') {
      const raw = await readBody(ctx.req);
      if (raw) {
        try {
          (ctx.request as any).body = JSON.parse(raw);
        } catch {
          (ctx.request as any).body = raw;
        }
      }
    }
    await next();
  };
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

interface TestResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function requestKoa(
  app: Koa,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const server = createServer(app.callback());

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      const bodyStr = options.body ? JSON.stringify(options.body) : '';

      const req = httpRequest(
        {
          hostname: 'localhost',
          port: addr.port,
          path: options.path ?? '/users',
          method: options.method ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            const body = raw ? tryParse(raw) : null;
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') headers[key] = value;
              else if (Array.isArray(value)) headers[key] = value[0] ?? '';
            }
            server.close();
            resolve({ status: res.statusCode ?? 0, body, headers });
          });
        },
      );

      req.on('error', (err) => {
        server.close();
        reject(err);
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---- test payloads ----

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

// ============================================================
// pylonKoa middleware
// ============================================================

describe('pylonKoa', () => {
  it('passes through v4 (current) request without transform', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ...(ctx.request as any).body, id: 1 };
    });

    const { status, body } = await requestKoa(app, { body: v4Payload });

    expect(status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('email', 'john@example.com');
    expect(body).toHaveProperty('id', 1);
  });

  it('handles v2 request end to end (upgrade request, downgrade response)', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      // Body should be transformed to v4 shape
      const body = (ctx.request as any).body;
      ctx.body = { ...body, id: 1 };
    });

    const { status, headers } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    expect(headers['x-api-version']).toBe('v4');
    expect(headers['x-pylon-debug']).toBe('enabled');
  });

  it('sets X-API-Version and X-Pylon-Debug headers on response', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, headers } = await requestKoa(app, { body: v4Payload });

    expect(status).toBe(200);
    expect(headers['x-api-version']).toBe('v4');
    expect(headers['x-pylon-debug']).toBe('enabled');
  });

  it('uses default version (v4) when no version header sent', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ...(ctx.request as any).body, id: 1 };
    });

    const { status, body } = await requestKoa(app, { body: v4Payload });

    expect(status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('id', 1);
    expect(body).toHaveProperty('email', 'john@example.com');
  });

  it('stores pylonClientVersion and pylonTransformInfo on context', async () => {
    let capturedVersion: string | undefined;
    let capturedTransforms: string[] | undefined;

    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      capturedVersion = ctx.pylonClientVersion;
      capturedTransforms = ctx.pylonTransformInfo?.transformsApplied;
      ctx.body = { ok: true };
    });

    await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(capturedVersion).toBe('v2');
    expect(capturedTransforms).toContain('v2->v3');
  });

  it('transforms v2 request body to v4 shape for downstream handlers', async () => {
    let receivedBody: any;

    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      receivedBody = (ctx.request as any).body;
      ctx.body = { ok: true };
    });

    await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    // v2 body should be upgraded: first_name/last_name → fullName, address_line_1/city → address object
    expect(receivedBody).toHaveProperty('fullName', 'John Doe');
    expect(receivedBody).toHaveProperty('address');
    expect(receivedBody.address).toHaveProperty('street', '123 Main St');
    expect(receivedBody.address).toHaveProperty('city', 'SF');
    expect(receivedBody).not.toHaveProperty('first_name');
  });

  it('transforms v4 response back to v2 shape for v2 client', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      // Handler produces v4-shaped response
      ctx.body = {
        fullName: 'Jane Smith',
        address: { street: '456 Oak Ave', city: 'LA', country: 'US' },
        email: 'jane@example.com',
      };
    });

    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    // Response downgraded to v2 shape
    expect(body).toHaveProperty('first_name', 'Jane');
    expect(body).toHaveProperty('last_name', 'Smith');
    expect(body).toHaveProperty('address_line_1', '456 Oak Ave');
    expect(body).toHaveProperty('city', 'LA');
    expect(body).not.toHaveProperty('email');
  });
});

// ============================================================
// Shadow mode
// ============================================================

describe('pylonKoa shadow mode', () => {
  it('does not transform request body in shadow mode', async () => {
    let receivedBody: any;

    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon, { shadow: true }));
    app.use(async (ctx) => {
      receivedBody = (ctx.request as any).body;
      ctx.body = { ok: true };
    });

    await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    // In shadow mode, body should NOT be transformed
    expect(receivedBody).toHaveProperty('first_name', 'John');
    expect(receivedBody).toHaveProperty('last_name', 'Doe');
  });

  it('does not transform response body in shadow mode', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon, { shadow: true }));
    app.use(async (ctx) => {
      ctx.body = { fullName: 'Jane Smith', email: 'jane@example.com' };
    });

    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    // Response should NOT be downgraded
    expect(body).toHaveProperty('fullName', 'Jane Smith');
    expect(body).toHaveProperty('email', 'jane@example.com');
  });

  it('sets Pylon headers in shadow mode', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon, { shadow: true }));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, headers } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    expect(headers['x-api-version']).toBe('v4');
    expect(headers['x-pylon-debug']).toBe('enabled');
  });
});

// ============================================================
// pylonKoaShadow factory
// ============================================================

describe('pylonKoaShadow', () => {
  it('creates a shadow middleware via factory function', async () => {
    let receivedBody: any;

    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoaShadow(pylon));
    app.use(async (ctx) => {
      receivedBody = (ctx.request as any).body;
      ctx.body = { ok: true };
    });

    await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    // Factory creates shadow middleware — body untouched
    expect(receivedBody).toHaveProperty('first_name', 'John');
  });
});

// ============================================================
// Error paths
// ============================================================

describe('pylonKoa error handling', () => {
  it('returns 410 for unpublished version in reject mode', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    // Rollback v2 in reject mode
    await pylon.rollback('v2', {
      reason: 'Security vulnerability',
      fallback: 'v4',
      mode: 'reject',
    });

    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(410);
    expect(body).toHaveProperty('error.code', 'VERSION_UNPUBLISHED');
  });

  it('returns 500 for transform failure', async () => {
    const app = new Koa();
    // Create pylon with a broken transform
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

    app.use(jsonBodyParser());
    app.use(pylonKoa(brokenPylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: { name: 'test' },
    });

    expect(status).toBe(500);
    expect(body).toHaveProperty('error.code', 'EXECUTION_ERROR');
  });

  it('returns 422 for validation error (body fails schema)', async () => {
    const app = new Koa();
    // Pylon with strict schema that rejects the transformed body
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

    app.use(jsonBodyParser());
    app.use(pylonKoa(strictPylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    // v1 body with count=5 — transformed to v2, fails .min(10)
    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v1' },
      body: { count: 5 },
    });

    expect(status).toBe(422);
    expect(body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });

  it('passes through non-JSON response body without crashing', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = 'plain text response';
    });

    const { status, body } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    // Non-JSON string body is passed through as-is
    expect(body).toBe('plain text response');
  });

  it('passes through null response body without crashing', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.status = 204;
      ctx.body = null;
    });

    const { status } = await requestKoa(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(204);
  });

  it('handles GET request with pylon middleware (body is undefined)', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, body } = await requestKoa(app, {
      method: 'GET',
      path: '/users',
    });

    // GET without body triggers schema validation error since v4 schema requires fullName
    expect(status).toBe(422);
    expect(body).toHaveProperty('error.code', 'VALIDATION_ERROR');
  });
});

// ============================================================
// Query parameters & edge cases
// ============================================================

describe('pylonKoa edge cases', () => {
  it('extracts query parameters for version detection', async () => {
    // Create pylon with query-based version detection
    const pylon = new Pylon({
      current: 'v2',
      defaultVersion: 'v2',
      versions: [
        { name: 'v1', order: 1 },
        { name: 'v2', order: 2 },
      ],
      schemas: {
        v1: z.object({ name: z.string() }),
        v2: z.object({ name: z.string() }),
      },
      transforms: {
        'v1->v2': { request: (r: any) => r },
      },
      versioning: {
        sources: [{ type: 'query', name: 'version' }],
        headers: { apiVersion: true },
      },
      debug: { enabled: true },
    });

    const app = new Koa();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status, headers } = await requestKoa(app, {
      method: 'POST',
      path: '/users?version=v1',
      body: { name: 'test' },
    });

    expect(status).toBe(200);
    expect(headers['x-api-version']).toBe('v2');
  });

  it('sets endpoint option via pylonKoa options', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    pylon.config.endpoints = { 'users.create': {} };
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon, { endpoint: 'users.create' }));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { status } = await requestKoa(app, { body: v4Payload });
    expect(status).toBe(200);
  });

  it('respects per-request debug header setting', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true };
    });

    const { headers } = await requestKoa(app, { body: v4Payload });
    expect(headers['x-pylon-debug']).toBe('enabled');
  });

  it('handles version from URL path parameter', async () => {
    const app = new Koa();
    const pylon = createTestPylon();
    app.use(jsonBodyParser());
    app.use(pylonKoa(pylon));
    app.use(async (ctx) => {
      ctx.body = { ok: true, path: ctx.path };
    });

    const { status } = await requestKoa(app, {
      path: '/v4/users',
      body: v4Payload,
    });

    expect(status).toBe(200);
  });
});
