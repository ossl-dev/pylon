import { Pylon } from '@ossl/pylon-core';
import express from 'express';
import { createServer, request as httpRequest, type Server } from 'http';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pylonExpress } from './index.js';

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

/**
 * Make an HTTP request to an Express app on a random port.
 * Starts a server, sends one POST /users request, collects the response,
 * then closes the server.
 */
function requestApp(
  app: express.Express,
  options: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);

    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      const bodyStr = options.body ? JSON.stringify(options.body) : '';

      const req = httpRequest(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/users',
          method: 'POST',
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
            const body = raw ? JSON.parse(raw) : null;
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === 'string') {
                headers[key] = value;
              } else if (Array.isArray(value)) {
                headers[key] = value[0] ?? '';
              }
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

describe('pylonExpress', () => {
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
    const app = express();
    app.use(express.json());
    const pylon = createTestPylon();
    app.use(pylonExpress(pylon));

    app.post('/users', (req, res) => {
      res.json({ ...(req.body as object), id: 1 });
    });

    const { status, body } = await requestApp(app, {
      body: v4Payload,
    });

    expect(status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('email', 'john@example.com');
    expect(body).toHaveProperty('id', 1);
  });

  it('handles v2 request end to end', async () => {
    const app = express();
    app.use(express.json());
    const pylon = createTestPylon();
    app.use(pylonExpress(pylon));

    app.post('/users', (_req, res) => {
      res.json({ ok: true });
    });

    const { status, headers } = await requestApp(app, {
      headers: { 'X-API-Version': 'v2' },
      body: v2Payload,
    });

    expect(status).toBe(200);
    expect(headers['x-api-version']).toBe('v4');
    expect(headers['x-pylon-debug']).toBe('enabled');
  });

  it('uses default version (v4) when no version header is sent', async () => {
    const app = express();
    app.use(express.json());
    const pylon = createTestPylon();
    app.use(pylonExpress(pylon));

    app.post('/users', (req, res) => {
      res.json({ ...(req.body as object), id: 1 });
    });

    const { status, body } = await requestApp(app, {
      body: v4Payload,
    });

    expect(status).toBe(200);
    expect(body).toHaveProperty('fullName', 'John Doe');
    expect(body).toHaveProperty('id', 1);
  });

  describe('processResponse direct', () => {
    it('transforms v4 response body back to v2 shape', async () => {
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
    });

    it('does not transform response for v4 (current) client', async () => {
      const pylon = createTestPylon();
      const v4Response = {
        fullName: 'John Doe',
        address: { street: '123 Main St', city: 'SF', country: 'US' },
        email: 'john@example.com',
      };

      const result = await pylon.processResponse('v4', v4Response, {}, []);
      expect(result.body).toEqual(v4Response);
    });
  });
});
