# Pylon

Dead simple API versioning.

[![CI](https://github.com/ossl/pylon/actions/workflows/ci.yml/badge.svg)](https://github.com/ossl/pylon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why Pylon

Keep one current handler while supporting older API contracts. Each endpoint declares its request and response schemas for every supported release. Explicit migrations upgrade requests and downgrade successful JSON responses.

Schemas enforce payload shapes. Historical fixtures verify behavior. Changes to authorization, database semantics, or side effects still need application tests.

## Quick Start

Run `pylon init` to create `pylon.config.ts` and a runnable Hono example. Or define an operation directly:

```typescript
import { defineEndpoint, Pylon, type EndpointInput, type EndpointResult } from '@ossl/pylon-core';
import { pylonHono } from '@ossl/pylon-hono';
import { Hono } from 'hono';
import { z } from 'zod';

const createUser = defineEndpoint({
  method: 'POST',
  path: '/users',
  contracts: {
    v1: {
      request: z.object({ name: z.string() }),
      response: z.object({ id: z.number(), name: z.string() }),
    },
    v2: {
      request: z.object({ fullName: z.string() }),
      response: z.object({ id: z.number(), fullName: z.string(), createdAt: z.iso.datetime() }),
    },
  },
  transforms: {
    'v1->v2': {
      request: (input) => ({ fullName: input.name }),
      response: (output) => ({ id: output.id, name: output.fullName }),
    },
  },
});
const pylon = new Pylon({
  current: 'v2',
  versions: ['v1', 'v2'],
  endpoints: { createUser },
});
const app = new Hono();
app.use('*', pylonHono(pylon));
app.post('/users', async (c) => {
  const input = await c.req.json<EndpointInput<typeof createUser, 'v2'>>();
  const output: EndpointResult<typeof createUser, 'v2'> = {
    id: 1, fullName: input.fullName, createdAt: new Date().toISOString(),
  };
  return c.json(output);
});
```

Send `api-version: v1` with `{"name":"Ada"}`; receive `{"id":1,"name":"Ada"}`. The handler always receives `fullName`. Contract projects default to this single version header; omitted headers select `current`.

Migration inputs and outputs are inferred from schemas. Request migrations accept parsed source input and produce target schema input; response migrations accept parsed current output and produce historical schema input. Each hop parses once, including Zod defaults, coercions, async refinements, and serialization transforms. `EndpointResult` describes handler output before parsing; `EndpointOutput` describes the resulting wire value.

Startup rejects missing contracts, missing migration directions, unknown versions, and invalid routes. Use `'identity'` explicitly when a direction is unchanged. String arrays list published releases in order: `['2026-01-01', '2026-04-15']` needs one hop. Date ranges generate every intermediate date and therefore require every hop.

Adapters select endpoint contracts by method and path, including whole-segment `:id` parameters. Routes outside a contract-only configuration pass through. Use `pylon.forEndpoint('createUser')` for low-level transforms or endpoint-specific tests; unknown names throw.

Invalid client payloads return 422; migration bugs and invalid handler output return 500. HTTP errors, HEAD, 204/205 responses, and non-JSON streams pass through. Successful JSON responses on the current version also validate. Declare the intended success status with `status` for OpenAPI output.

Global `schemas` and `transforms` remain available for legacy integrations. They validate current requests and cannot distinguish request and response contracts. `pylon doctor` audits their migration paths without executing user functions.

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
  versions: { format: 'date-daily', dateFormat: 'YYYY-MM-DD', start: '2026-01-01' },
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
    { name: 'legacy', order: 1, aliases: ['v1', 'v1.0', 'v1.0.0'], deprecated: true },
    { name: 'beta', order: 2 },
    { name: 'stable', order: 3 },
  ],
});
```

Presets: `semantic`, `numeric`, `date-monthly`, `date-daily`, `calver`, `stripe`. Custom parsers and comparators for anything else.

---

## Framework Adapters

Adapters support Hono, Express, Fastify, Koa, and Next.js App Router:

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

Hono and Next buffer at most 1 MiB of JSON per request/response by default. Override in adapter options:

```typescript
app.use('*', pylonHono(pylon, {
  bodyLimits: { request: 256 * 1024, response: 2 * 1024 * 1024 },
}));
// Next: pylonNext(pylon, { bodyLimits: { request: 256 * 1024 } })(handler)
```

Budgets count actual UTF-8 bytes, including chunked bodies. Oversized requests return 413 before migrations or handlers; oversized JSON responses return 500 before emitting their payload. Response budgets apply before and after migration. Error responses and non-JSON streams bypass response budgeting. Non-JSON request bodies bypass parsing; required JSON request schemas still validate missing input. Register Hono middleware before body readers to enforce limits before buffering; Express/Koa/Fastify request parsers need their own limits. Budgets cannot constrain allocations inside user migrations.

## Webhook Versioning

Webhook payloads use response migrations. Scope the instance to the operation whose response contract matches the event payload:

```typescript
import { PylonWebhook } from '@ossl/pylon-webhooks';

const webhooks = new PylonWebhook(pylon.forEndpoint('createUser'));
await webhooks.register({
  url: 'https://customer.example/webhook', events: ['user.created'], version: 'v1', secret: 'whsec_...',
});
await webhooks.send({
  event: 'user.created',
  payload: { id: 1, fullName: 'Ada', createdAt: new Date().toISOString() },
});
```

## Historical Contract Tests

Send fixtures in the selected version's wire format and assert the actual wire response. Request and response migrations can be lossy; the test helper never guesses an inverse.

```typescript
import { timeTravel } from '@ossl/pylon-testing';

await timeTravel(pylon.forEndpoint('createUser'), async (version, request) => {
  const response = await request('POST', '/users', {
    body: version === 'v1' ? { name: 'Ada' } : { fullName: 'Ada' },
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual(version === 'v1'
    ? { id: 1, name: 'Ada' }
    : { id: 1, fullName: 'Ada', createdAt: expect.any(String) });
}, { baseUrl: 'http://localhost:3000' });
```

`timeTravel` and `snapshotVersion` default to published versions and verify that the request selects the intended release. Snapshots contain wire responses. Supply explicit versions to test rejected releases; snapshot callbacks receive the selected version as their second argument.

## CLI

```sh
pylon init                          # Working two-version config and Hono example
bun pylon.example.ts                # Run both fixtures in process
pylon doctor --json                 # Validate contracts and migration coverage
pylon schema show v1 --endpoint createUser --direction response
pylon schema validate v1 --endpoint createUser --input request.json
pylon diff v1 v2 --endpoint createUser --direction response --json
pylon generate openapi --version v1 -o openapi-v1.json
pylon generate openapi --all-versions -o specs
pylon bench v1 v2 --endpoint createUser --mode pipeline \
  --input request.json --response response.json -n 1000 --json
pylon generate changelog v1..v2 -o changes/v2.md
pylon generate changelog v1..v2 --json
pylon transform graph --json
pylon transform run v1 v2 --endpoint createUser --input request.json --json
pylon transform run v2 v1 --endpoint createUser --direction response --input response.json
pylon version deprecate v1
pylon version unpublish v1
pylon version publish v1
pylon version retire v1
```

OpenAPI uses declared methods, paths, statuses, and separate request/response schemas. It does not invent routes for legacy global schemas. Combined specs use `anyOf` for overlapping release schemas; separate specs describe one release.

Unpublish rejects requests after config reload. Retirement retains contracts and migration hops so newer clients still work. Retired releases cannot be republished. Contract rollbacks use `reject`; clients explicitly select a published release. Version edits validate before writing and preserve runtime schemas and functions.

Schema diffs report fields and JSON schema constraints. Renames require intent; matching shapes cannot prove a rename. Generated changelogs compare each operation’s declared request/response schemas and list registered hops in the selected range. They do not execute migrations or infer business behavior. Scaffolding and the playground remain unfinished.

`pylon transform run` executes migrations locally once and reports detached input/output snapshots, timings, and fallback/error status for each hop. It validates source and intermediate contracts through the runtime pipeline. User migration functions still run normally, including any side effects they perform. `pylon.trace(source, target, direction, fixture)` exposes the same report; snapshots require structured-cloneable values. Ordinary transforms allocate no snapshots. Schema failures include structured issue paths in error details.

## Performance

Execution steps, composed functions, endpoint instances, and route matchers are cached per configuration. Static route selection uses a map. Synchronous migrations avoid unnecessary awaits; asynchronous migrations remain supported.

`pylon bench` measures your fixtures, with parsing, migrations, validation in pipeline mode, and serialization. Results include cold latency, warm mean/median/p99, and throughput. `bun run bench -- 1000 --json` runs the repository matrix: core, Hono, Next, plain Hono baseline, roughly 1/16/64 KiB payloads, zero/one/three hops, sync/async migrations. These are sequential in-process measurements; use load tests for network latency and concurrency.

---

## Observability

Use `observability.onTransform`, `observability.onError`, and `onTransformError` to connect your metrics and logging.

Set `debug.enabled` to include transform traces in processing results. The debug header indicates that this mode is enabled.

---

## Response Headers

```http
X-API-Version: v2
Deprecation: true
Sunset: Sat, 31 Dec 2026 23:59:59 GMT
Link: <https://docs.example.com/migrate-v1-to-v2>; rel="sunset"
```

`X-API-Version` identifies the current implementation. Deprecation headers describe the requested release. Configure sources, missing/invalid-version policies, and response headers through `versioning`.

Debug output can include payloads; enable it only where that is appropriate. Use `debug.enabled` and observability callbacks. The former `rateLimit`, response `headers.debug`, and observability boolean switches are rejected because they never implemented those features.

---

## Requirements

* Node.js 20+ (22.12+ for the CLI)
* Bun 1.3.14+ for development
* TypeScript 6 for development

---

## License

MIT
