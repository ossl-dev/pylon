# Changelog

## Unreleased

- Bound Hono/Next JSON buffering and migrated responses; reject oversized requests with 413 and oversized server responses with 500. Next request parsing no longer clones streams.
- Fix request migrations returning `undefined` so handlers do not receive stale historical bodies.

- Fix build and lint configuration, source-only tests, and supported Node engines.
- Enforce version rejection and transform failures across all five adapters; add a shared contract suite.
- Cache transform execution steps per engine; isolate endpoint overrides and retain rollback state.
- Preserve runtime config during CLI version edits; load TypeScript configs and generate OpenAPI specs.
- Add UTC date ranges with explicit bounds, calendar validation, and aliases for explicit versions.
- Fix time-travel version headers, contract round trips, and replay of lossy webhook payloads. Webhook history defaults to 1000 deliveries, configurable with `historyLimit`.
- Preserve JSON fields without changing output prototypes; handle cyclic defaults and spaced or Unicode combined values.

- Add typed endpoint request/response contracts, startup coverage validation, explicit identity migrations, and sparse release lists.
- Parse every contract hop, validate current JSON responses, preserve cookies and streams, and bypass undeclared routes.
- Add runnable CLI onboarding, `doctor --json`, real schema inspection/diffs, per-release OpenAPI output, and fixture pipeline benchmarks.
- Retain retired migration history; persisted unpublish/retire metadata rejects requests after reload.
- Add a core/Hono/Next benchmark matrix; avoid cloning response streams when replacing their bodies.

### Compatibility changes

- Hono/Next JSON request and processed-response budgets default to 1 MiB. Configure adapter `bodyLimits` to permit larger payloads.

- `timeTravel` and `snapshotVersion` send historical wire fixtures and return actual wire responses. They no longer infer inverse request/response migrations.
- Contract migrations require both directions, using `'identity'` when unchanged. Contract rollbacks reject unpublished releases; clients select alternatives explicitly.
- Unknown endpoint names now throw. Unimplemented rate-limit and observability boolean options are rejected; use host middleware and observability callbacks.
- OpenAPI uses declared operation paths; legacy global schemas export components without invented routes.

### Added
- Unit tests for all adapter packages: koa (21), next (18), openapi (44), webhooks (22), testing (24), cli (76)
- GitHub Actions CI workflow: lint, typecheck, test matrix (Node 22/24, Bun 1.x), dependency audit
- LICENSE (MIT), CONTRIBUTING.md, CODE_OF_CONDUCT.md
- Full date range generation for date-monthly, date-daily, calver, and Stripe preset version formats

### Changed
- **Breaking (security):** Webhook `signPayload` now uses HMAC-SHA256 via Web Crypto API instead of a non-cryptographic rolling hash. Signatures are now 64-character hex strings instead of 8 characters.

### Fixed
- Koa adapter: shadow mode now sets Pylon response headers (X-API-Version, X-Pylon-Debug)
- OpenAPI generator: public Zod JSON schema conversion, independent request/response schemas, and recursive reference rebasing
- CLI audit: route handler detection now correctly counts handlers instead of dead `lastIndex` check
- Biome config `$schema` updated from 1.9.4 to 2.5.0
- Vitest version normalized across all packages (devtools was on 3.1.2, now 4.1.8)
- Version normalizer: date-based formats now generate intermediate versions instead of a single entry

### Known issues
- Devtools Transform Playground is a stub
- CLI scaffolding, changelog generation, and the playground remain unfinished
- No docs site yet
