# Changelog

## Unreleased

- Fix build and lint configuration, source-only tests, and supported Node engines.
- Enforce version rejection and transform failures across all five adapters; add a shared contract suite.
- Cache transform execution steps per engine; isolate endpoint overrides and retain rollback state.
- Preserve runtime config during CLI version edits; load TypeScript configs and generate OpenAPI specs.
- Add UTC date ranges with explicit bounds, calendar validation, and aliases for explicit versions.
- Fix time-travel version headers, contract round trips, and replay of lossy webhook payloads. Webhook history defaults to 1000 deliveries, configurable with `historyLimit`.
- Preserve JSON fields without changing output prototypes; handle cyclic defaults and spaced or Unicode combined values.

### Added
- Unit tests for all adapter packages: koa (21), next (18), openapi (44), webhooks (22), testing (24), cli (76)
- GitHub Actions CI workflow: lint, typecheck, test matrix (Node 22/24, Bun 1.x), dependency audit
- LICENSE (MIT), CONTRIBUTING.md, CODE_OF_CONDUCT.md
- Full date range generation for date-monthly, date-daily, calver, and Stripe preset version formats

### Changed
- **Breaking (security):** Webhook `signPayload` now uses HMAC-SHA256 via Web Crypto API instead of a non-cryptographic rolling hash. Signatures are now 64-character hex strings instead of 8 characters.

### Fixed
- Koa adapter: shadow mode now sets Pylon response headers (X-API-Version, X-Pylon-Debug)
- OpenAPI generator: zod v4 `_def` compatibility — enum entries, literal values, array element type, string/number checks
- CLI audit: route handler detection now correctly counts handlers instead of dead `lastIndex` check
- Biome config `$schema` updated from 1.9.4 to 2.5.0
- Vitest version normalized across all packages (devtools was on 3.1.2, now 4.1.8)
- Version normalizer: date-based formats now generate intermediate versions instead of a single entry

### Known issues
- Devtools Transform Playground is a stub
- CLI scaffolding, changelog generation, and the playground remain unfinished
- No docs site yet
