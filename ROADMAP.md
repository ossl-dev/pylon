# Pylon Roadmap

Things to build, fix, and improve. Checked boxes mean shipped.

**Want to contribute?** Pick an unchecked box, open an issue saying you're on it, send a PR. Keep one item per PR. If something's unclear, open an issue and ask — don't guess.

---

## Current focus: contract confidence

Make one current implementation reliable for every published client release. Runtime schemas, inferred migration types, HTTP tests, and generated specs share each endpoint's contracts.

- [x] Separate request and response contracts per endpoint; infer migration inputs and outputs
- [x] Validate adjacent migration coverage at startup; require explicit identity directions
- [x] Support sparse release lists and retain retired migration history
- [x] Validate every migration hop, including async schemas, defaults, and coercions
- [x] Test historical wire fixtures without inferring request/response inverses
- [x] Generate specs from real methods and paths, including one spec per published release
- [x] Generate a runnable two-version starter; audit configs with `doctor --json`
- [x] Inspect and diff real JSON schemas, including nested constraints
- [x] Measure core and adapter pipelines across payload sizes and sync/async hops
- [ ] Scaffold migrations from explicit rename/default decisions, then generate wire fixture tests
- [x] Enforce UTF-8 JSON budgets in Hono/Next buffering adapters; document host parser limits
- [ ] Add HTTP load benchmarks with concurrency, memory use, and network latency
- [ ] Add adoption examples for existing production routes

Framework expansion, dashboards, and automatic semantic inference follow this work.

---

## Phase 1 — Ship what we have

Stuff that's built but not finished, tested, or released.

### Tests

Core, transforms, adapters, CLI, OpenAPI, testing, and webhooks have unit coverage. The adapters also share a contract suite.

- [x] Add unit tests for `@ossl/pylon-koa` — middleware, shadow mode, error paths
- [x] Add unit tests for `@ossl/pylon-next` — route handler wrapper, request passthrough
- [x] Add unit tests for `@ossl/pylon-openapi` — Zod-to-OpenAPI conversion, declared endpoint paths, recursive schemas, edge cases
- [x] Add unit tests for `@ossl/pylon-testing` — timeTravel, snapshotVersion, testTransform, assertContract
- [x] Add unit tests for `@ossl/pylon-webhooks` — registration, send, migration grace period, replay
- [x] Add unit tests for `@ossl/pylon-cli` — each action (init, diff, scaffold, generate, bench, audit, transform)
- [x] Add E2E / integration tests — each adapter tested with real HTTP servers (koa, express, fastify, next, hono)
- [x] Add adapter contract test suite — same test cases run against every adapter (Hono, Express, Fastify, Koa, Next)

### CLI

Onboarding, diagnosis, schema inspection, spec generation, and fixture benchmarks work. Scaffolding and generated changelogs remain unfinished.

- [x] Finish `pylon init` — generate typed contracts and a runnable example; scanning only suggests release labels
- [ ] Finish `pylon scaffold` — generate real transform files (not TODO placeholders)
- [x] Finish `pylon generate openapi` — run the OpenAPI generator and write the spec to disk
- [x] Finish `pylon diff` — compare actual JSON schema fields and constraints; do not infer renames
- [ ] Finish `pylon audit` — check all registered transforms for gaps, warn about missing version hops
- [x] Finish `pylon bench` — measure real fixtures through transforms or the full request/response pipeline
- [x] Add `pylon doctor` — check config validity, endpoint contracts, and migration paths
- [x] Add `--json` output for doctor, diff, and benchmark commands

### Docs

The `apps/docs/` directory is empty. The README is solid but there's no reference site.

- [ ] Set up a docs site (VitePress or Starlight) in `apps/docs/`
- [ ] Add API reference for every package (core, transforms, each adapter, testing, webhooks, openapi)
- [ ] Add a "Quick start" guide — install, configure two versions, add a transform, see it work
- [ ] Add per-adapter setup guides with copy-pasteable code
- [ ] Add a troubleshooting page — common errors, framework quirks, version format gotchas
- [ ] Add a "How it works" deep-dive page — request flow diagram, transform chain compilation, caching

### CI / infra

CI runs build, lint, typecheck, tests, and a dependency audit.

- [x] Set up GitHub Actions — lint, typecheck, test on push and PR
- [x] Add test matrix for supported Node 22/24 and Bun 1.x
- [ ] Add CI badge matrix to README (one per package)
- [x] Add dependency audit step (bun audit or npm audit)
- [x] Add Biome format + lint check in CI (currently configured but not enforced)
- [ ] Add Changesets release workflow — publish to npm on merge to main

### Finish stubs

Code that exists but doesn't actually do the thing yet.

- [ ] **`@ossl/pylon-devtools`** — the Transform Playground is a stub. Build an actual web UI where you can paste JSON, pick a transform, and see the output.
- [x] **Version normalizer date formats** — `date-daily`, `date-monthly`, `calver`, and Stripe preset all fall through to a single version entry. Generate the full version range from the format.
- [x] **Webhook signing** — `signPayload` uses a plain hash. Replace with HMAC-SHA256 before anyone uses it in production.

### Housekeeping

- [x] Add LICENSE file (README says MIT, no file exists)
- [x] Add CONTRIBUTING.md — dev setup, script docs, PR process
- [x] Add CODE_OF_CONDUCT.md
- [x] Add CHANGELOG.md (or automate it via Changesets)
- [x] Normalize TypeScript version — root uses 6.x, packages use 5.8.3. Pick one and align.
- [x] Normalize Vitest version — devtools uses 3.1.2, everything else uses 4.1.8
- [x] Fix Biome config `$schema` version — references 1.9.4 but uses 2.5.0

---

## Phase 2 — Core improvements

Make the engine faster, safer, more flexible.

### Transform engine

- [x] Validate contract coverage at config time and intermediate shapes at runtime
- [ ] Add `beforeAll` / `afterAll` hooks — run a transform before/after every version hop (useful for logging, metrics, auth header migration)
- [ ] Support conditional transforms — "if the request has field X, apply this transform; otherwise skip"
- [ ] Add transform dry-run mode — pass a sample payload through a chain and see each step's output
- [x] Benchmark and optimize chain compilation — cache compiled functions and execution steps per engine; keep endpoint caches isolated

### Version normalizer

- [x] Full date format support — generate UTC ranges between `start` and `end` for daily, monthly, CalVer, and Stripe formats
- [x] Custom label ordering with aliases — explicit definitions accept aliases; alias chains are validated
- [ ] Version sunset automation — auto-deprecate versions past their sunset date
- [ ] Support non-linear version graphs — branches (e.g. `v1` → `v2`, but also `v1` → `v1-experimental`)

### Config

- [x] Infer config literals and migration callback types from TypeScript and Zod
- [ ] Config file merging — load `pylon.config.ts` + env-specific overrides
- [x] Validate every contract version hop; doctor reports legacy gaps
- [x] Detect request cycles; contract migrations must follow adjacent forward releases

### Error handling

- [ ] Better transform error messages — include the version hop, field name, and input value that caused the failure
- [ ] Add a debug mode that logs every transform step with before/after payloads
- [x] Distinguish client errors (400/422) from server transform errors (500) across all adapters

---

## Phase 3 — New features

New capabilities that expand what Pylon can version.

### Beyond REST

- [ ] **GraphQL versioning** — version GraphQL schema fields, upgrade deprecated fields to current, downgrade responses
- [ ] **gRPC versioning** — intercept protobuf messages, apply field transforms
- [ ] **WebSocket versioning** — upgrade/downgrade messages on a socket connection by version handshake
- [ ] **Event / message versioning** — version events in a queue or event bus (Kafka, SQS, etc.)

### Schema-driven transforms

Pylon currently requires you to write transforms by hand. The long-term vision is schema-awareness.

- [x] **Schema diff** — export Zod through its public JSON schema API and compare fields and constraints
- [ ] **Scaffold transforms from schema diffs** — require explicit rename, default, and removal decisions
- [ ] **Schema evolution linting** — warn on breaking changes (field removed without deprecation, type narrowed)
- [x] **OpenAPI versioned specs** — generate one OpenAPI spec per published version

### Version management UX

- [ ] `pylon dashboard` — a local web UI showing all versions, their status (active/deprecated/sunset), and transform chains
- [ ] Version analytics — track which API versions clients are hitting, deprecation adoption rate
- [ ] `pylon changelog` — auto-generate a changelog from transform definitions (what changed between v1 and v2)

### Multi-service

- [ ] **Service-level versioning** — one Pylon config that manages versions across multiple services, with shared version definitions
- [ ] **Cross-service transform sharing** — define a transform once, use it in multiple services (e.g. rename `userId` → `accountId` everywhere)
- [ ] **Version header propagation** — pass the client's API version through to downstream service calls

---

## Phase 4 — Framework adapters

Each adapter should feel native, not like a port.

### Existing adapters

- [ ] **Express**: redesign to avoid monkey-patching `res.json` / `res.send`. Explore using a Router-level middleware that intercepts before the response is written.
- [ ] **Fastify**: add `onRoute` hook integration so version config can be applied per-route at registration time
- [x] **Koa**: add tests
- [ ] **Next.js**: add App Router `middleware.ts` support (edge-compatible, runs before route handlers)
- [ ] **Hono**: add Hono RPC integration — versioned client types generated from server schema

### New adapters

- [ ] **Elysia** adapter (Bun-native, Eden Treaty integration)
- [ ] **Hapi** adapter
- [ ] **NestJS** adapter (decorator-based)
- [ ] **Lambda / API Gateway** adapter — parse version from API Gateway stage or custom header
- [ ] **Cloudflare Workers** adapter — lightweight, runs on the edge
- [ ] **Deno** adapter — native `Deno.serve` HTTP server
- [ ] **Remix / React Router v7** adapter

### Adapter quality standards

- [x] Every adapter must pass the shared contract test suite
- [ ] Every adapter must have a shadow mode variant
- [ ] Every adapter must have typed request augmentation (version info available in route handlers)
- [ ] Every adapter readme must have a working copy-paste example

---

## Phase 5 — Ecosystem & DX

Make Pylon feel like a mature tool.

### DevTools Transform Playground

The `@ossl/pylon-devtools` package is a stub. Build it out.

- [ ] Interactive web UI — paste input JSON, pick source and target versions, see the transformed output
- [ ] Visual transform chain — see each hop in the chain, expand to see before/after
- [ ] Share playground links — encode the config and input in the URL
- [ ] Embed in docs site for interactive examples

### Editor integration

- [ ] VS Code extension — syntax highlighting for transform files, inline schema validation, "Go to transform" from route files
- [ ] VS Code snippets — `pylon-init`, `pylon-transform`, `pylon-version`
- [ ] LSP-ish features — autocomplete for version names in config, error underlines for broken transform chains

### Real-world examples

- [ ] `examples/` directory in the repo — each example is a self-contained project
- [ ] Example: simple REST API with 3 versions (rename field, add field, deprecate endpoint)
- [ ] Example: user-facing API with date-based versions
- [ ] Example: internal service-to-service versioning with webhooks
- [ ] Example: Stripe-style named versions with custom ordering

### Distribution

- [ ] npm publish pipeline for all packages (currently 0.0.1, not published)
- [ ] JSR publish for `@ossl/pylon-core` and `@ossl/pylon-transforms` (zero-dep, works everywhere)
- [ ] Homebrew formula for `@ossl/pylon-cli`
- [ ] Docker image with pre-built CLI for CI pipelines

---

## Phase 6 — Hard problems

Longer-term, research-heavy items. Don't need to start soon, but worth thinking about.

- [ ] **Migration generation** — generate both directions from explicit mapping rules. Request and response contracts are independent; never infer one from the other.
- [ ] **Version deprecation enforcement** — at the proxy/infrastructure level, block requests from sunset versions (410 Gone) before they reach your app
- [ ] **Distributed version registry** — a central (or federated) registry of API versions across services in an org. "Service A v3 depends on Service B v2."
- [ ] **A/B version testing** — route a percentage of traffic to a new version, compare error rates and latency
- [ ] **Migrate-as-you-go** — instrument old-version requests, generate a migration guide specific to each client's usage patterns

---

## Bugs & known issues

Not triaged into phases. Fix anytime.

- [ ] **Express interception** — methods are patched per response and restored. Verify middleware that captures response methods and investigate router-level alternatives.
- [x] **Webhook signing** — HMAC-SHA256 via Web Crypto.
- [x] **Date format normalizers** — UTC ranges with explicit bounds and calendar validation.
- [x] **TypeScript version mismatch** — every package uses 6.x.
- [x] **Vitest version mismatch** — every package uses 4.1.8.
- [x] **Biome configuration** — v2 schema and shared settings wired into package lint commands.
- [x] **Package engines** — minimum Node versions declared; the CLI requires 22.12+.
- [x] **Next.js scope** — documented as an App Router adapter. Pages Router support remains unimplemented.
- [ ] **Transform engine error strategy `log-and-continue`** — add a default logger when no `onTransformError` callback is supplied.
- [x] **Version detector path parsing** — match complete segments, handle nested paths and trailing slashes, and support global custom patterns.
- [x] **JSON body budgets** — Hono/Next enforce configurable 1 MiB defaults while reading streams. Host parsers enforce Express/Koa/Fastify request limits.
- [ ] **Shadow mode logs full request/response bodies** — potential data leak in production if turned on accidentally. Add body redaction or truncation.

---

## Ideas / maybe someday

Not committed. Brainstorming parking lot.

- **API versioning as a service** — a proxy/ sidecar that versions any HTTP API without code changes. Parse OpenAPI specs, infer transforms, do it at the network layer.
- **Git-like version branching** — branch your API (`v2-beta`), merge transforms from main into the branch, eventually merge back. Version history as a DAG.
- **Visual schema diff tool** — like a git diff but for API schemas. Side-by-side view of v1 and v2, color-coded adds/removals/renames.
- **Client SDK generation** — generate typed client SDKs that know about API versions. `client.getUser()` calls the right version and handles response downgrades automatically.
- **AI-assisted transform generation** — "I renamed `userName` to `displayName` in v3" → generates the transform, tests, and docs. Not a replacement for writing transforms, but a speedup for simple ones.
- **Compatibility matrix** — a YAML/JSON file that maps client SDK versions to API versions. "If a client is on SDK 2.x, they're hitting API v3." Useful for support and deprecation planning.
- **Webhook version negotiation** — webhook consumers declare their supported version, the sender downgrades to the highest mutually supported version.
- **Semantic versioning for APIs** — map semver semantics (major = breaking, minor = additive, patch = fix) onto API versioning. Auto-detect what kind of version bump a transform represents.
- **OpenAPI-native mode** — define your API versions entirely in OpenAPI extensions, skip the Pylon config. For teams that already live in OpenAPI-first workflows.
- **Federated version graph** — across microservices, trace a request's version through every service it touches. "This request came in as v2 on the gateway, got upgraded to v4 on the user service, and v3 on the billing service."
