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

## Manual-only entrypoints (NOT CI-wired, by design)

These are reachable only via their npm alias and are intentionally **not** run in
CI — do not mistake them for dead aliases. They are diagnostic/perf tools that
drive the **real** built CLI end-to-end, so they require a **fresh** `pnpm build`
first (a stale `dist/` silently runs old behavior; the scripts warn but cannot
detect it):

| Alias                     | Script                           | What it's for                                                             |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `pnpm bench:fork-cost`    | `bench-fork-cost.mjs`            | Spec-02 subprocess-all evidence: real fit/graph worker vs in-process wall time. |
| `pnpm bench:partition`    | `bench-partition-strategies.mjs` | ADR-0045 graph partition-strategy benchmark (cold/warm, shard balance).   |
| `pnpm graph:catalog-diff` | `graph-catalog-diff.mjs`         | Function-set delta between the `exact` and `sharded` graph build engines. |

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
