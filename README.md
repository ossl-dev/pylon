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
  -> Schema Validation: v4 response
  -> Response Transform: v4 -> v2
  -> Client (v2)
```

Requests on the current version pay zero overhead. The identity function is inlined by V8. Legacy versions pay roughly 0.1ms per transform hop. Predictable, bounded, negligible.

---

## Quick Start

```typescript
import { Pylon } from '@ossl/pylon-core';
import { z } from 'zod';

const pylon = new Pylon({
  current: 'v4',
  defaultVersion: 'v4',

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
        fullName: combine(req.first_name, req.last_name),
        address: {
          street: req.address_line_1,
          city: req.city,
        },
      }),
      response: (res) => ({
        first_name: split(res.fullName, 0),
        last_name: split(res.fullName, 1),
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

When you change the v4 schema, TypeScript forces you to update every transform that touches v4. You cannot break an old API version without the compiler stopping you.

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

// Next.js
import { pylonNext } from '@ossl/pylon-next';
export default pylonNext(pylon)(handler);
```

The Express adapter monkey patches `res.json`/`res.send`/`res.end`. It works but is inherently fragile. For new projects, Hono and Fastify provide clean, supported interception hooks.

---

## Webhook Versioning

Pylon versions webhooks using the same transform engine. Register a webhook endpoint with its version:

```typescript
import { pylonWebhook } from '@ossl/pylon-webhooks';

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

describe('POST /users', () => {
  timeTravel(pylon, async (version, request) => {
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
pylon bench v2->v4                  Benchmark transform performance
```

---

## Observability

OpenTelemetry metrics built in:

| Metric | Description |
|--------|-------------|
| `pylon.requests.total` | Request count by version, endpoint, method |
| `pylon.transform.duration` | Transform latency by source, target |
| `pylon.transform.errors` | Transform failures by error type |
| `pylon.validation.errors` | Schema validation failures |

Debug headers injected in development mode show the full transform trace.

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

Adopt Pylon on an existing API in 5 phases:

1. **Audit**: `pylon audit ./src` finds all versioning patterns in your codebase
2. **Scaffold**: `pylon scaffold ./src` generates initial config and transforms
3. **Gradual adoption**: Wrap one endpoint at a time alongside existing versioning
4. **Dual running**: Shadow mode logs what Pylon would do without transforming
5. **Cutover**: Remove old versioning code

No big bang migrations. No rewrites.

---

## Architecture

Three pillars:

* **Schemas**: Runtime validation via Zod (primary), with adapters for TypeBox, Valibot, ArkType. TypeScript types inferred from schemas. OpenAPI spec generation.
* **Transforms**: Pure functions that convert between versions. Graph compilation at startup. Function composition and memoization. Roughly 0.1ms per hop. Async transforms supported with startup warnings.
* **Adapters**: Framework specific request and response interception.

---

## Requirements

* Node.js 20+
* Bun 1.2+
* TypeScript 5.5+

---

## License

MIT
