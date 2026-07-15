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

## Platform acceptance (installed-artifact qualification)

`run-platform-acceptance.mjs` drives the installed-artifact acceptance harness —
it installs a real candidate build into a hermetic run root, runs the closed
common journey catalog against it, and writes ONE sealed, versioned evidence
artifact. `verify-platform-acceptance.mjs` is a **separate** process that
independently re-validates that artifact. A workflow must run both: a passing
runner console exit is never trusted on its own.

The full architecture, evidence schema, cleanup model, and reason-code-keyed
troubleshooting live in a local-only maintainer note under `docs/internal/`
(private working context, not committed to the repo); the evidence-authority and
non-product decision is
[ADR-0164](../docs/decisions/ADR-0164-installed-artifact-platform-acceptance-evidence.md).

- **Stable entry points (the only supported way to invoke the harness):**
  - `pnpm platform:acceptance -- <args>` → `run-platform-acceptance.mjs`
  - `pnpm platform:acceptance:verify -- <args>` → `verify-platform-acceptance.mjs`
  - Both print a closed-grammar `--help`; pass `-- --help` to see it.
- **Prerequisites:** the harness needs an already-built, packed (or published)
  candidate — it does **not** build for you. For the packed form, first run the
  release pack + artifact steps so the tarball directory contains the npm
  tarballs plus `opensip-cli-release-manifest.v1.json` + `SHA256SUMS` (the same
  directory `release-preflight.mjs` builds; see `build-release-artifacts.mjs`).
  The acceptance candidate-source re-verifies those checksums independently
  before any tarball is trusted.
- **Two candidate forms (exactly one per run):**
  - `--packed-release <dir> [--expected-version <semver>]` — qualify freshly
    packed release tarballs verified against the manifest + `SHA256SUMS`.
  - `--published-version <semver> [--previous-version <semver>] [--registry <https-url>]`
    — qualify an exact published version already on a registry (npmjs by
    default; an explicit HTTPS mirror only).
- **Exit semantics — run (`run-platform-acceptance.mjs`):**
  `0` pass · `1` a completed profile with an unsatisfied required journey ·
  `2` invalid invocation / profile / candidate · `3` infrastructure fault before
  trustworthy evidence. `--out <path>` (absolute, outside the run root) receives
  the sealed evidence; `--json-summary` prints exactly one JSON summary object to
  stdout (counts + required-failure ids only — never child stdout/stderr).
- **Exit semantics — verify (`verify-platform-acceptance.mjs`):** `0` verified ·
  non-zero not verified/invalid (`1` = evidence loaded but did not verify;
  `2` = invalid invocation or an unreadable profile/evidence file). It loads the
  profile independently, revalidates the evidence schema, and recomputes the
  profile digest, summary, verdict, and sealed-body digest — cross-checking each
  against the artifact and requiring the terminal completion record. `--json`
  prints exactly one machine result. It never echoes diagnostic tails, candidate
  registry URLs, or absolute paths.
- **Output/evidence handling:** the evidence file is the durable artifact a
  workflow uploads; the console summaries are bounded and secret-free. Optional
  `--expected-version` / `--expected-candidate-digest` and host constraints
  (`--expect-platform` / `--expect-arch` / `--expect-node-abi` / `--expect-fs-type`)
  let a workflow pin the identity + host the evidence must attest to. The macOS
  plan (and future OS profiles) extend this closed set; the base seam does not
  change.
- **Relationship to `smoke-pack`:** `smoke-pack.mjs` stays the fast
  cross-platform release check (a command-only subset projected from the same
  catalog). Full OS qualification is an **additional** consumer that runs
  after/reuses packed artifacts (or an exact staged published version); it is
  deliberately NOT wired into `release-preflight.mjs` or any developer build,
  because it is heavier and host-specific.
- **Rule — not a support declaration:** a passing common profile qualifies the
  tested bytes on the tested host only. It is evidence, **not** a declaration of
  official platform support; a support matrix is a separate, deliberate decision.

## Public installer

`install.sh` is the canonical source for
`curl -fsSL https://opensip.ai/cli/install.sh | bash`. It is end-user-facing
(not a dev/CI script): it enforces the Node floor, installs `opensip-cli`
globally, and runs a post-install smoke test. ShellCheck lints it, and
`packages/cli/src/__tests__/install-sh-contract.test.ts` asserts its smoke
commands stay in lockstep with the live CLI flag surface.
