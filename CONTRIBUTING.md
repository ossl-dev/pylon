# Contributing to Pylon

Thanks for contributing! Pylon is an API versioning toolkit for TypeScript.
Here's how to get started.

## Dev setup

```bash
git clone https://github.com/ossl/pylon.git
cd pylon
bun install
bun run build
bun run test
```

This is a Turborepo monorepo. Packages live in `packages/`, shared tooling in `tooling/`.

## Scripts

| Command | What it does |
|---------|-------------|
| `bun run build` | Build all packages (tsc) |
| `bun run test` | Run all tests (vitest) |
| `bun run lint` | Lint all packages (biome) |
| `bun run typecheck` | Type-check all packages |
| `bun run clean` | Remove dist folders |

Per-package: `cd packages/koa && bun run test`.

## Project structure

```
packages/
├── core/          @ossl/pylon-core       — engine, version normalizer, detector
├── transforms/    @ossl/pylon-transforms — built-in transforms
├── cli/           @ossl/pylon-cli        — CLI (init, diff, scaffold, bench, etc.)
├── koa/           @ossl/pylon-koa        — Koa adapter
├── express/       @ossl/pylon-express    — Express adapter
├── fastify/       @ossl/pylon-fastify    — Fastify adapter
├── hono/          @ossl/pylon-hono       — Hono adapter
├── next/          @ossl/pylon-next       — Next.js App Router adapter
├── openapi/       @ossl/pylon-openapi    — Zod → OpenAPI converter
├── testing/       @ossl/pylon-testing    — test helpers (timeTravel, assertContract)
├── webhooks/      @ossl/pylon-webhooks   — webhook versioning
├── devtools/      @ossl/pylon-devtools   — Transform Playground (WIP)
```

## PR process

1. Open an issue describing what you want to build or fix.
2. Branch from `main`, write your code, add tests.
3. Run `bun run test` and `bun run lint` — both must pass.
4. Open a PR. Keep it to one package or one concern.
5. All PRs require at least one approving review.

## Code style

- **TypeScript** with strict mode. No `any` without a biome-ignore comment explaining why.
- **Biome** for formatting and linting. Run `bun run lint` before pushing.
- **Tests** use Vitest. Tests live next to source: `src/index.test.ts`.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/).
