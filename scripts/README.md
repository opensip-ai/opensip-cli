# `scripts/`

Repo tooling for OpenSIP CLI: docs/manifest generators, CI gates, the release
lane, and the public installer. These are **not** part of the pnpm workspace —
they are deliberately dependency-free `.mjs`/`.sh` files with no build step and
no per-script `package.json`, so they can run on a bare checkout before anything
is built.

## Conventions

- **Language:** zero-dependency Node ESM (`.mjs`) or POSIX `sh`. Avoid adding
  npm deps; if you need a workspace symbol, the script is probably in the wrong
  layer.
- **Linted by:** ESLint (`scripts/**/*.{mjs,js}`, via `pnpm lint`) and
  ShellCheck (`scripts/*.sh`, a dedicated CI step).
- **Tested by:** `pnpm test:scripts` (`node --test "scripts/**/*.test.mjs"`).
  `turbo run test` (i.e. `pnpm test`) only visits workspace packages, so it does
  **not** cover `scripts/` — the `test:scripts` lane and its CI step exist
  precisely to close that gap. Add new script tests as `scripts/**/*.test.mjs`
  and the glob picks them up automatically.
- **`--check` idiom:** most generators have a `--check` mode that regenerates
  into memory and fails on drift instead of writing. CI runs the `--check`
  variant; you run the writing variant locally and commit the result.

## Docs generators

| Alias                        | Script                            | What it updates                                                                                                                                                                                                                |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm docs:performance-slos` | `build-performance-slo-doc.mjs`   | Renders SLO tiers and budgets from `.config/performance-slos.json` into `docs/public/70-reference/11-performance-slos.md`.                                                                                                     |
| `pnpm docs:benchmarks`       | `build-public-benchmarks-doc.mjs` | Renders public benchmark tables from `docs/public/70-reference/benchmark-snapshot.json` into `docs/public/70-reference/12-public-benchmarks.md`. Refresh the snapshot with `pnpm docs:benchmarks -- --report slo-report.json`. |

## Benchmark entrypoints

These drive the **real** built CLI end-to-end, so they require a fresh build. The
local aliases that start with `pnpm bench:` build first; CI-only aliases assume
the workflow has already run the repository build step.

| Alias                     | Script                           | What it's for                                                                   |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm bench:fork-cost`    | `bench-fork-cost.mjs`            | Spec-02 subprocess-all evidence: real fit/graph worker vs in-process wall time. |
| `pnpm bench:partition`    | `bench-partition-strategies.mjs` | ADR-0045 graph partition-strategy benchmark (cold/warm, shard balance).         |
| `pnpm bench:slo`          | `bench-slo.mjs`                  | Performance SLO lane over deterministic synthetic corpora.                      |
| `pnpm bench:slo:ci`       | `bench-slo.mjs`                  | CI form of the SLO lane; uses the already-built CLI dist output.                |
| `pnpm quality:measure`    | `measure-detection-quality.mjs`  | Detection-quality lane over the seeded labeled corpus; builds first.            |
| `pnpm quality:measure:ci` | `measure-detection-quality.mjs`  | CI form of the quality lane; uses the already-built workspace dist output.      |
| `pnpm graph:catalog-diff` | `graph-catalog-diff.mjs`         | Function-set delta between the `exact` and `sharded` graph build engines.       |

The detection-quality corpus lives under `scripts/quality/fixtures/`. It is a
checked-in, redistributable seed corpus; local generated reports such as
`detection-quality-report*.json` and temporary `.opensip-quality/` workdirs stay
untracked. Refresh the committed baseline with `pnpm quality:measure:update`
after a deliberate check or corpus change.

## Release lane

The release/publish tooling is human/agent-run, not CI-triggered on PRs. Start
from [`RELEASING.md`](../RELEASING.md), not from the scripts directly. The single
source of truth for the publishable package set + order is
`release-package-order.mjs` (ADR-0017), consumed by `verify-release.mjs`,
`verify-supply-chain.mjs`, `verify-release-publish-surface.mjs`,
`release-preflight.mjs`, `sync-package-licenses.mjs`, `bootstrap-publish.sh`, and
`.github/workflows/release.yml`. `bootstrap-publish.sh` is a rare first-publish
step for brand-new `@opensip-cli/*` packages (OIDC cannot bootstrap a
package name that does not yet exist on npm); a CI contract test pins it to the
source list, so it must stay in sync.

## Public installer

`install.sh` is the canonical source for
`curl -fsSL https://opensip.ai/cli/install.sh | bash`. It is end-user-facing
(not a dev/CI script): it enforces the Node floor, installs `opensip-cli`
globally, and runs a post-install smoke test. ShellCheck lints it, and
`packages/cli/src/__tests__/install-sh-contract.test.ts` asserts its smoke
commands stay in lockstep with the live CLI flag surface.
