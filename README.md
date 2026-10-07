# Pylon

Dead simple API versioning.

[![CI](https://github.com/ossl/pylon/actions/workflows/ci.yml/badge.svg)](https://github.com/ossl/pylon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## The Problem

Every API eventually breaks its contract. Engineering teams then face a choice: fork the codebase and maintain N parallel versions, or force every customer onto the latest version with a migration window. Neither scales.

Codebase forks create exponential maintenance burden. A bug in one version must be found and fixed in N versions. Customer migrations create tension between product velocity and reliability. Well funded teams like Stripe, Twilio, and Shopify solved this by building internal versioning layers. Everyone else reinvents broken solutions.

Pylon is that internal versioning layer, released as open source.

---

## How It Works

You maintain one codebase, the current version. Pylon intercepts every request, upgrades it to the current version, runs your modern controller, and downgrades the response back to the caller's version.

```
Client (v2)
  -> Version Detection
  -> Request Transform: v2 -> v4 (fills in defaults)
  -> Schema Validation: v4
  -> Controller (only knows v4)
  -> Response Transform: v4 -> v2
  -> Client (v2)
```

Requests on the current version skip the transform chain. Historical versions run cached adjacent transforms; latency depends on the functions you provide.

---

## Quick Start

```typescript
import { Pylon } from '@ossl/pylon-core';
import { defaults, drop } from '@ossl/pylon-transforms';
import { z } from 'zod';

const pylon = new Pylon({
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
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    }),
    v4: z.object({
      fullName: z.string(),
      address: z.object({
        street: z.string(),
        city: z.string(),
        country: z.string().default('US'),
      }),
      email: z.string().email(),
    }),
  },

  transforms: {
    'v2->v3': {
      request: (req) => ({
        fullName: req.name,
        address: {
          street: req.address_line_1,
          city: req.city,
        },
      }),
      response: (res) => ({
        name: res.fullName,
        address_line_1: res.address.street,
        city: res.address.city,
      }),
    },
    'v3->v4': {
      request: (req) => defaults(req, {
        address: { country: 'US' },
        email: 'unknown@example.com',
      }),
      response: (res) => drop(res, ['email']),
    },
  },
});
```

Schemas validate upgraded request bodies at runtime. Use contract tests to check that transforms preserve the behavior expected by historical clients.

---

## Version Naming

Pylon supports any version naming convention. The normalization engine parses, orders, and maps external version strings to internal indices.

```typescript
// Semantic versions
const pylon = new Pylon({
  current: 'v4',
  versions: { format: 'semantic', prefix: 'v' },
});

// Stripe style date versions
const pylon = new Pylon({
  current: '2026-04-25',
  versions: { format: 'date-daily', dateFormat: 'YYYY-MM-DD' },
});

// CalVer
const pylon = new Pylon({
  current: '2026.06',
  versions: { format: 'calver', calverFormat: 'YYYY.MM' },
});

// Custom labels with explicit ordering
const pylon = new Pylon({
  current: 'stable',
  versions: [
    { name: 'legacy', order: 1, deprecated: true },
    { name: 'beta', order: 2 },
    { name: 'stable', order: 3 },
  ],
});
```

Presets: `semantic`, `numeric`, `date-monthly`, `date-daily`, `calver`, `stripe`. Custom parsers and comparators for anything else.

---

## Framework Adapters

Pylon works with every major Node.js framework:

```typescript
// Hono (cleanest integration)
import { pylonHono } from '@ossl/pylon-hono';
app.use('*', pylonHono(pylon));

// Express
import { pylonExpress } from '@ossl/pylon-express';
app.use(pylonExpress(pylon));

// Fastify
import { pylonFastify } from '@ossl/pylon-fastify';
fastify.register(pylonFastify, { pylon });

// Koa
import { pylonKoa } from '@ossl/pylon-koa';
app.use(pylonKoa(pylon));

// Next.js App Router
import { pylonNext } from '@ossl/pylon-next';
export const POST = pylonNext(pylon)(handler);
```

The Express adapter monkey patches `res.json`/`res.send`/`res.end`. It works but is inherently fragile. For new projects, Hono and Fastify provide clean, supported interception hooks.

---

## Webhook Versioning

Pylon versions webhooks using the same transform engine. Register a webhook endpoint with its version:

```typescript
import { PylonWebhook } from '@ossl/pylon-webhooks';

const pylonWebhook = new PylonWebhook(pylon);

await pylonWebhook.register({
  url: 'https://customer.com/webhook',
  events: ['user.created'],
  version: 'v2',
  secret: 'whsec_...',
});

// Pylon automatically transforms the payload to v2 format
await pylonWebhook.send({
  event: 'user.created',
  payload: { fullName: 'John Doe', email: 'john@example.com', address: { ... } },
});
```

---

## Time Travel Testing

Write tests once against the current version. Pylon runs them against every historical version automatically.

```typescript
import { timeTravel } from '@ossl/pylon-testing';

it('POST /users works across versions', async () => {
  await timeTravel(pylon, async (version, request) => {
    const response = await request('POST', '/users', {
      body: { fullName: 'John Doe', email: 'john@example.com', address: { ... } },
    });
    expect(response.status).toBe(201);
  });
});
```

---

## CLI

```
pylon init                          Create config interactively
pylon init --preset stripe          Use Stripe versioning
pylon version list                  Show all versions
pylon version add v5                Add new version
pylon version deprecate v2          Mark deprecated
pylon version unpublish v4          Emergency rollback
pylon audit ./src                   Analyze code for version patterns
pylon diff v3 v4                    Show changelog
pylon generate openapi              Generate OpenAPI spec
pylon playground                    Transform Playground web UI
pylon bench v2 v4                  Benchmark transform performance
```

---

## Observability

Use `observability.onTransform`, `observability.onError`, and `onTransformError` to connect your metrics and logging.

Set `debug.enabled` to include transform traces in processing results. The debug header indicates that this mode is enabled.

---

## Response Headers

Pylon injects standard HTTP headers:

```
X-API-Version: v4
X-API-Version-Requested: v2
Deprecation: true
Sunset: Sat, 31 Dec 2026 23:59:59 GMT
Link: <https://docs.example.com/migrate-v2-to-v4>; rel="deprecation"
```

---

## Migration

The planned migration workflow has 5 phases. Audit is available; scaffolding and the playground remain unfinished:

1. **Audit**: `pylon audit ./src` finds all versioning patterns in your codebase
2. **Scaffold**: `pylon scaffold ./src` generates initial config and transforms
3. **Gradual adoption**: Wrap one endpoint at a time alongside existing versioning
4. **Dual running**: Shadow mode logs what Pylon would do without transforming
5. **Cutover**: Remove old versioning code

No big bang migrations. No rewrites.

---

## Architecture

Three pillars:

* **Schemas**: Runtime request validation with Zod and OpenAPI spec generation.
* **Transforms**: Functions that convert between adjacent versions. Execution steps and composed functions are cached per engine. Synchronous and asynchronous functions are supported.
* **Adapters**: Framework specific request and response interception.

---

## Requirements

* Node.js 20+ (22.12+ for the CLI)
* Bun 1.3.14+ for development
* TypeScript 6 for development

---

## License

MIT
