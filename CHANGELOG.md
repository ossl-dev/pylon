# Changelog

## Unreleased

### Added
- Unit tests for all adapter packages: koa (21), next (18), openapi (44), webhooks (22), testing (24), cli (76)
- GitHub Actions CI workflow: lint, typecheck, test matrix (Node 18/20/22, Bun 1.x), dependency audit
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
- `assertContract` response check applies response transform directly to sample input, not to the request-transformed output
- Devtools Transform Playground is a stub
- Several CLI commands (generate, diff, playground) are stubs
- No docs site yet
