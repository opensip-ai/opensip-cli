# Toolchain support matrix

Contributor and CI environment expectations for the opensip-cli monorepo.

## Supported runtime

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | ≥ 24 | Pinned in `.nvmrc` and `package.json#engines` |
| pnpm | 11.5.x | `packageManager` field in root `package.json` |

## Build and quality toolchain

| Component | Version (approx.) | Risk note |
|-----------|-------------------|-----------|
| TypeScript | ~6.0 | Frontier major; watch release notes on bump |
| ESLint | 10.x | Flat config only (`.config/eslint.config.mjs`) |
| Vitest | 4.x | Coverage thresholds enforced per package |
| Turborepo | 2.x | Task cache; use `--force` for release-preflight freshness |
| dependency-cruiser | 17.x | Architecture layer gate in `pnpm lint` |

## Verification commands

```bash
pnpm install && pnpm build
pnpm typecheck && pnpm test && pnpm lint
pnpm fit:ci && pnpm graph:ci
```

## Frontier pinning rationale

The repo tracks recent majors (Node 24+, TS 6, ESLint 10) to dogfood modern
tooling and catch ecosystem breakage early. This trades a wider contributor
floor for faster signal on upstream regressions. Pin your local Node via
`nvm use` (reads `.nvmrc`) and pnpm via Corepack (`corepack enable`).

## Getting help

- [Contributing guide](./CONTRIBUTING.md)
- [Architecture map](./docs/public/80-implementation/architecture-map.md)
- [GitHub issues](https://github.com/opensip-ai/opensip-cli/issues)