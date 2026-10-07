# Pylon Roadmap

Things to build, fix, and improve. Checked boxes mean shipped.

**Want to contribute?** Pick an unchecked box, open an issue saying you're on it, send a PR. Keep one item per PR. If something's unclear, open an issue and ask — don't guess.

---

## Phase 1 — Ship what we have

Stuff that's built but not finished, tested, or released.

### Tests

Core and transforms are well-tested. The rest needs coverage.

- [x] Add unit tests for `@ossl/pylon-koa` — middleware, shadow mode, error paths
- [x] Add unit tests for `@ossl/pylon-next` — route handler wrapper, request passthrough
- [x] Add unit tests for `@ossl/pylon-openapi` — Zod-to-OpenAPI conversion, path inference, edge cases
- [x] Add unit tests for `@ossl/pylon-testing` — timeTravel, snapshotVersion, testTransform, assertContract
- [x] Add unit tests for `@ossl/pylon-webhooks` — registration, send, migration grace period, replay
- [x] Add unit tests for `@ossl/pylon-cli` — each action (init, diff, scaffold, generate, bench, audit, transform)
- [x] Add E2E / integration tests — each adapter tested with real HTTP servers (koa, express, fastify, next, hono)
- [x] Add adapter contract test suite — same test cases run against every adapter (Hono, Express, Fastify, Koa, Next)

### CLI

Commands are wired up with Commander but most action implementations are stubs.

- [ ] Finish `pylon init` — generate a working `pylon.config.ts` by scanning your route files
- [ ] Finish `pylon scaffold` — generate real transform files (not TODO placeholders)
- [x] Finish `pylon generate openapi` — run the OpenAPI generator and write the spec to disk
- [ ] Finish `pylon diff` — compare two version configs and show what changed (fields added, removed, renamed)
- [ ] Finish `pylon audit` — check all registered transforms for gaps, warn about missing version hops
- [ ] Finish `pylon bench` — run real benchmark suites against transform chains
- [ ] Add `pylon doctor` — check project setup, config validity, adapter compatibility
- [ ] Add `--json` output flag for CI consumption

### Docs

The `apps/docs/` directory is empty. The README is solid but there's no reference site.

- [ ] Set up a docs site (VitePress or Starlight) in `apps/docs/`
- [ ] Add API reference for every package (core, transforms, each adapter, testing, webhooks, openapi)
- [ ] Add a "Quick start" guide — install, configure two versions, add a transform, see it work
- [ ] Add per-adapter setup guides with copy-pasteable code
- [ ] Add a troubleshooting page — common errors, framework quirks, version format gotchas
- [ ] Add a "How it works" deep-dive page — request flow diagram, transform chain compilation, caching

### CI / infra

No CI exists yet.

- [x] Set up GitHub Actions — lint, typecheck, test on push and PR
- [x] Add test matrix for Node 18/20/22 and Bun 1.x
- [x] Add CI badge matrix to README (one per package)
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

- [ ] Add transform chain validation at config time — warn if a chain produces invalid intermediate shapes
- [ ] Add `beforeAll` / `afterAll` hooks — run a transform before/after every version hop (useful for logging, metrics, auth header migration)
- [ ] Support conditional transforms — "if the request has field X, apply this transform; otherwise skip"
- [ ] Add transform dry-run mode — pass a sample payload through a chain and see each step's output
- [x] Benchmark and optimize chain compilation — cache compiled functions and execution steps per engine; keep endpoint caches isolated

### Version normalizer

- [ ] Full date format support — generate all versions between `start` and `end` for `date-daily` and `date-monthly`
- [ ] Custom label ordering with aliases — allow `v1`, `v1.0`, `v1.0.0` to all map to the same version
- [ ] Version sunset automation — auto-deprecate versions past their sunset date
- [ ] Support non-linear version graphs — branches (e.g. `v1` → `v2`, but also `v1` → `v1-experimental`)

### Config

- [ ] Add `$schema` field to generated config for editor autocomplete
- [ ] Config file merging — load `pylon.config.ts` + env-specific overrides
- [ ] Validate that every version hop has a registered transform (warn on gaps)
- [ ] Detect circular transform chains at config time

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

- [ ] **Schema diff** — diff two Zod schemas and detect added, removed, renamed, and retyped fields
- [ ] **Auto-generate transforms from schema diffs** — rename fields, add defaults, drop removed fields automatically
- [ ] **Schema evolution linting** — warn on breaking changes (field removed without deprecation, type narrowed)
- [ ] **OpenAPI versioned specs** — generate one OpenAPI spec per version, not just the current one

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

- [ ] **Bidirectional transforms** — given a forward transform (v1 → v2), can we infer the reverse? For simple renames and defaults, yes. For structural changes, probably not. Explore how far we can push it.
- [ ] **Version deprecation enforcement** — at the proxy/infrastructure level, block requests from sunset versions (410 Gone) before they reach your app
- [ ] **Distributed version registry** — a central (or federated) registry of API versions across services in an org. "Service A v3 depends on Service B v2."
- [ ] **A/B version testing** — route a percentage of traffic to a new version, compare error rates and latency
- [ ] **Migrate-as-you-go** — instrument old-version requests, generate a migration guide specific to each client's usage patterns

---

## Bugs & known issues

Not triaged into phases. Fix anytime.

- [ ] **Express adapter monkey-patches `res.json`/`res.send`/`res.end`** — works but fragile. Interceptors are restored after each response, but concurrent requests or middleware that caches `res` methods will break.
- [ ] **Webhook `signPayload` is not cryptographically secure** — uses a simple hash instead of HMAC-SHA256. Marked with a code comment, needs real implementation before any production use.
- [ ] **Date format version normalizers return a single version** — `date-daily`, `date-monthly`, `calver`, and Stripe preset don't generate version ranges. They should compute all versions between `start` and the current date.
- [ ] **TypeScript version mismatch** — root `package.json` has TS 6.0.3, all packages have 5.8.3. Builds work but tooling gets confused.
- [ ] **Vitest version mismatch** — `@ossl/pylon-devtools` uses vitest 3.1.2, everything else uses 4.1.8.
- [ ] **Biome `$schema` references version 1.9.4** but the project uses Biome 2.5.0. `biome check` works but the schema is stale.
- [ ] **No `engines` field in any package.json** — should document minimum Node.js and Bun versions.
- [ ] **`@ossl/pylon-next` only supports App Router** — Pages Router is not documented or tested. Either add support or explicitly state it's App Router only.
- [ ] **Transform engine error strategy `log-and-continue`** — logs to console by default. Should accept a custom logger so it integrates with existing logging setups.
- [ ] **Version detector path parsing** — path pattern `/v:version/` only matches a single segment. Nested paths like `/api/v1/users` work but `/api/v1/` with trailing config won't match if there's extra structure.
- [ ] **No request body size limit handling** — if a request body is very large, the transform engine will buffer it entirely in memory. Add streaming or size limits.
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
