# Dogfood `fit` against opensip-tools

Wire opensip-tools to run its own fitness checks against itself in CI, and port the two remaining cross-repo check candidates whose patterns apply here.

## Problem

opensip-tools is a static-analysis toolkit that ships fit/sim/graph as a CLI. We don't currently use it on ourselves in any automated way:

- `pnpm fit` exists in `package.json:11` and `opensip-tools.config.yml` (at the repo root, 140 lines) is fully configured with targets and 27 disabled checks for tech we don't use. Running `pnpm fit` works locally today.
- **CI does NOT run `pnpm fit`.** `.github/workflows/ci.yml:30-46` runs `pnpm build`, `pnpm typecheck`, `pnpm test`, and `node tools/build-web-docs.mjs --check`. There is no fitness-check step.
- No baseline workflow exists. We cannot ratchet (accept current violations and prevent new ones) without one.
- No SARIF upload to GitHub. Violations have no permanent record visible to reviewers in the PR UI.
- No project-local recipe file under `opensip-tools/fit/recipes/` (only `opensip-tools/graph/baseline.json` exists). Default in-code recipe is used.

Two consequences:
1. **No dogfooding.** Bugs in our own checks (false positives, scope mismatches, performance issues against large workspaces) only surface when external users hit them.
2. **No code-quality ratchet.** The codebase can drift without anyone noticing — a new `console.log` or `it.only` lands and no automated gate catches it.

A prior analysis (`docs/plans/dogfood-check-candidates.md`, now moved to `references/candidates-original.md`) identified 5 "strong-port" candidate checks from the sibling repo `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/`. **Three of those five are already ported**:

| Source check | Status in opensip-tools |
|---|---|
| `arch-cli-realpath-validation` | ✅ `packages/fitness/checks-typescript/src/checks/security/cli-realpath-validation.ts` |
| `arch-callback-invocation-safe` | ✅ `packages/fitness/checks-typescript/src/checks/resilience/callback-invocation-safe.ts` |
| `quality-log-event-name-shape` | ✅ `packages/fitness/checks-typescript/src/checks/quality/observability/logger-event-name-format.ts` |
| `testing-no-focused-tests` | ❌ not present |
| `quality-no-console-log` | ❌ not present |

So the real scope is: **two check ports + a dogfood loop**, not five ports.

## Target State

After this plan ships:

1. **CI runs `pnpm fit` on every PR** against the opensip-tools codebase. The job uploads SARIF to GitHub so violations appear inline on PR diffs via the Security tab.
2. **Ratchet on new violations** is in place. The exact mechanism is settled in Phase 0 — the candidate mechanisms (see Phase 0 Task 0.2) are:
   - **(C) GitHub Code Scanning ratchet** — upload SARIF to GH Code Scanning every run; rely on GH's "new alerts vs. main" diff (UI-side) plus optional branch protection on Code Scanning to enforce. Works with the current opensip-tools baseline implementation as-is.
   - **(A) Fix-now hard gate** — clear current violations as part of this plan, then `failOnErrors: 1` (already set) becomes the gate.
   - **(B) Defer until SARIF-import lands** — opensip-tools currently has one-way SARIF export (`fit-baseline-export --out`) but no committed-baseline-import path. A follow-up plan would add the missing import direction; this plan defers the workflow-level ratchet until then.

   The plan defaults to **(C)** unless Phase 0's audit (Task 0.1) shows <20 existing violations, in which case **(A)** is also viable.
3. **Two new checks** land — both **project-local** under `opensip-tools/fit/checks/`, auto-discovered by the plugin loader (per `packages/core/src/plugins/discover.ts:266`: `LOOSE_FILE_EXTENSIONS = ['.js', '.mjs']`):
   - **`no-focused-tests`** — flags `describe.only`, `it.only`, `test.only`, `fit(`, `fdescribe(` in test files.
   - **`no-console-log`** — flags `console.{log,error,warn,info,debug}` outside the allowlist (`packages/core/src/lib/logger.ts`, `packages/cli-ui/**`).

   **Why project-local for both?** opensip-tools is open-source. The `opensip-tools/fit/checks/` directory doubles as **documentation-by-example** — anyone evaluating opensip-tools can read the `.mjs` files top-to-bottom to see how `defineCheck` is actually used. First-party checks ship via npm but are invisible until a consumer opens node_modules; project-local checks are on display the moment someone browses the GitHub source. The two checks here establish the pattern; follow-up plans grow the catalog.

4. **`opensip-tools/fit/checks/README.md`** explains the directory's dual purpose (project-local enforcement + teaching artifact for plugin authors) and the conventions every check in this directory follows.
4. **The candidates analysis is superseded** by this plan. Old file removed; reference copy preserved at `references/candidates-original.md` for historical context.

What this plan deliberately does NOT do:

- Port `arch-fs-path-canonical-realpath` — broader than the already-ported `cli-realpath-validation`, would require auditing every `fs.<verb>(<computed_path>)` call across packages. Worth its own plan. Noted in the Phases table as a follow-up.
- Port `subprocess-no-argv-secret` — requires prior argv-secret audit of `packages/cli/src/commands/plugin.ts:346,402`. Out of scope per source candidates doc.
- Port OTel-tier checks (`foundation-tier-no-io`) — opensip-tools has no OTel instrumentation yet.
- Add a custom recipe file under `opensip-tools/fit/recipes/`. The default in-code recipe is fine; we can add a recipe later if we want to vary check selection between local-dev and CI runs.

## Design Principles

**No backwards compatibility.** Changes replace the old approach entirely. The candidates doc is superseded, not merged. The CI workflow gains a new step, not a feature-flagged toggle.

**Observability.** opensip-tools uses structured Pino-style logging via `@opensip-tools/core`'s logger module (`packages/core/src/lib/logger.ts:1-17` documents the convention: `evt: 'domain.component.action'`). The `fit` runner already emits structured events when checks run; no new observability instrumentation is needed in this plan — the checks themselves produce `CheckViolation[]` arrays that the engine already logs. **The fitness engine's existing logging is the dogfood loop's observability surface.**

**Wiring.** Two wiring points matter and each phase identifies which it touches:
1. `.github/workflows/ci.yml` (Phase 1) — adds CI steps that invoke `pnpm fit:ci`, export SARIF, and upload to GH Code Scanning.
2. Project-local discovery (Phases 2, 3) — `opensip-tools/fit/checks/*.mjs` files are auto-discovered by `packages/core/src/plugins/discover.ts` per the `LOOSE_FILE_EXTENSIONS` set at line 266. No barrel or display registry changes needed; the loader walks the directory at startup and registers anything that exports a `checks` array.

**Conventions** (from `CLAUDE.md`):
- **Test framework:** Vitest. Test files: `*.test.ts` alongside source, or under `__tests__/<slug>.test.ts` (the pattern used by all existing checks-typescript).
- **AST helpers:** TS-AST checks use `@opensip-tools/lang-typescript` helpers (`getSharedSourceFile`, `walkNodes`, etc.) per CLAUDE.md. The two ports here are regex-based and don't need AST helpers, but the shared `isTestFile` predicate from `@opensip-tools/fitness` MUST be used in preference to inlining test-path detection.
- **Imports:** workspace packages via `@opensip-tools/*` barrels. Internal imports use relative paths with `.js` extension (ESM Node16). Type-only imports use `import type`.
- **Error pattern:** `ToolError` with `code` field. Checks return `CheckViolation[]` from `analyze()`; the engine handles errors. Per the existing `incomplete-regex-escaping.ts:218-220` pattern: `try { ... } catch { /* @swallow-ok parse failure */ }` is the canonical shape for catching ts-parser failures inside `analyze`.
- **Layer rules:** `checks-typescript` may import from `@opensip-tools/fitness` and `@opensip-tools/lang-typescript`. May NOT import from `cli`, `contracts`, `core` (kernel), `simulation`, or other check packs. Enforced by dependency-cruiser.
- **UUIDs:** every `defineCheck({ id: '...' })` UUID must be freshly generated. Source-repo UUIDs are owned by that repo's registry.
- **`@fitness-ignore-file <slug>` pragma:** every check that supports a file-level ignore must implement it the same way (regex test against the first ~50 lines). See `cli-realpath-validation.ts:52,68-69` for the canonical pattern.

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | Audit & Design | Document current dogfood state; pin down CI strategy, baseline strategy, SARIF integration. No code. | — |
| 1 | CI Integration | Wire `pnpm fit` into `.github/workflows/ci.yml` with baseline-first run and SARIF upload. | 0 |
| 2 | Port `no-focused-tests` | Add the check + tests + barrel + display entry. Smallest, simplest port. Validates the port pattern. | 0 |
| 3 | Port `no-console-log` | Add the check + tests + barrel + display entry. Allowlist must include logger.ts + cli-ui. | 0 |
| 4 | Tests | Integration test that runs `pnpm fit` programmatically against a fixture and asserts both new checks fire; baseline-roundtrip test. | 2, 3 |
| 5 | Verification | Run the full dogfood loop locally + in CI on an open PR. Inspect SARIF in GH Security tab. Confirm dashboard renders new checks. | All |

**Follow-up plan candidates** (NOT in this plan):
- **Grow the local-checks catalog.** This plan establishes the `opensip-tools/fit/checks/` pattern with two checks. A follow-up plan brainstorms 3–5 additional opensip-tools-specific project-local checks that encode conventions unique to this codebase (e.g. layer-policy invariants beyond what dependency-cruiser catches, naming patterns for the `evt:` field, `defineCheck` shape conventions, etc.). Each new check is both enforcement AND a worked example for readers learning to author checks.
- Port `arch-fs-path-canonical-realpath` (broader path-traversal guard for all `fs.<verb>(<computed_path>)` calls in `packages/**`). Would require a full audit. Recommend a separate plan.
- Argv-secret audit of `packages/cli/src/commands/plugin.ts` + port `subprocess-no-argv-secret`.
- Iso-timestamp convention codification + port `arch-canonical-iso-timestamp-default`.

## Dependency Graph

```
Phase 0 (Audit & Design)
├── Phase 1 (CI Integration)
│       └── Phase 5 (Verification)
├── Phase 2 (Port no-focused-tests)  ──┐
└── Phase 3 (Port no-console-log)    ──┤
                                       └── Phase 4 (Tests)
                                              └── Phase 5 (Verification)
```

Phases 1, 2, and 3 are mutually independent and may run in parallel (separate PRs). Phase 4 depends on 2 and 3 (it tests both new checks). Phase 5 depends on everything.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md` (moved from old location)<br>`opensip-tools/fit/checks/README.md` | — |
| 1 | — (no new committed files; `fit.sarif` is a CI workflow artifact, not committed) | `.github/workflows/ci.yml`, `package.json`, `CLAUDE.md` |
| 2 | `opensip-tools/fit/checks/no-focused-tests.mjs` (project-local, auto-discovered) | — (no barrel / display registry changes) |
| 3 | `opensip-tools/fit/checks/no-console-log.mjs` (project-local, auto-discovered) | — (no barrel / display registry changes) |
| 4 | `packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts` | — |
| 5 | — | (none beyond what 0–4 changed) |

`docs/plans/dogfood-check-candidates.md` is moved (not deleted) as part of Phase 0 to `docs/plans/ready/dogfood-fit-against-self/references/candidates-original.md`.

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `opensip-tools.config.yml` | Root signalers/fitness config | `targets:` (lines 14-104), `fitness:` (line 105), `disabledChecks:` (lines 107-end). `failOnErrors: 1`. |
| `.github/workflows/ci.yml` | CI workflow | Lines 30-46: build, typecheck, test, docs:check. **Phase 1 adds a step after `docs:check`.** |
| `package.json` | Root scripts | Line 11: `"fit": "node packages/cli/dist/index.js fit"`. Phase 1 may add `pnpm fit:ci` if CI-specific flags are needed. |
| `packages/fitness/engine/src/tool.ts` | `fit` subcommand registration | Lines 176-195 register the `fit` Commander command with all its options. **Key flags:** `--gate-save` (line 194) and `--gate-compare` (line 195) are **boolean flags**, NOT path-taking. Both read/write the project SQLite store at `opensip-tools/.runtime/datastore.sqlite` (which is gitignored). `--report-to <url>` (line 186) POSTs to an HTTP URL — NOT a SARIF emitter. |
| `packages/fitness/engine/src/cli/baseline-export.ts` | `fit-baseline-export` command (separate from `fit`) | Reads the SQLite-stored baseline and writes SARIF to `--out <path>` (line 270 of `tool.ts`). One-way export. **No corresponding import command exists** — committed SARIF cannot be re-loaded into a different machine's SQLite baseline. |
| `packages/fitness/engine/src/index.ts` | `@opensip-tools/fitness` public API | Exports `defineCheck`, `isTestFile`, `isInsideStringLiteral`, `stripStringsAndComments`, `CheckViolation`, recipe types. |
| `packages/fitness/checks-typescript/src/index.ts` | Pack barrel | `collectCheckObjects(allChecks)` (line 21) auto-collects everything `src/checks/index.ts` re-exports. |
| `packages/fitness/checks-typescript/src/checks/index.ts` | Category barrel | `export * from './<category>/index.js'` for each category. |
| `packages/core/src/plugins/discover.ts` | Project-local plugin discovery | Line 266: `LOOSE_FILE_EXTENSIONS = ['.js', '.mjs']`. Phases 2 and 3 produce auto-discovered files in `opensip-tools/fit/checks/`. |
| `opensip-tools/fit/checks/` | Project-local checks dir (created by Phase 0) | Holds `no-focused-tests.mjs` (Phase 2) and `no-console-log.mjs` (Phase 3) initially. Follow-up plans grow this directory with opensip-tools-specific checks. |
| `opensip-tools/fit/checks/README.md` | Directory README (created by Phase 0) | Explains the dual purpose: project-local enforcement AND teaching artifact for plugin authors. Future checks landing here follow the conventions documented in the README. |
| `packages/fitness/checks-typescript/src/checks/quality/incomplete-regex-escaping.ts` | Reference: existing first-party TS-AST check (~225 lines). | Useful background for the first-party shape (Phases 2 and 3 use the project-local shape, not this one). |
| `packages/core/src/plugins/__tests__/discover.test.ts` | Reference: discovery test fixtures | Lines 68-104 show the expected `.mjs` shape (`export const checks = []`). Phase 3 follows this. |
| `packages/fitness/checks-typescript/src/checks/security/cli-realpath-validation.ts` | Reference: a previously-ported first-party check (already done). | Shows the first-party port pattern. Phases 2 and 3 don't follow this exact pattern (they go project-local), but it's useful background. |
| `packages/core/src/lib/logger.ts` | Project's logger module | Line 7 documents the `evt` convention. `no-console-log` allowlist must include this file. |
| `packages/cli-ui/src/` | Ink/React components | Ink legitimately writes to stdout. `no-console-log` allowlist must include this tree. |
| `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/testing/no-focused-tests.ts` | **Source** for Phase 2 | 102 lines. Pure regex. References `maskCommentsLines` from source's shared/ — must be re-implemented or use `stripStringsAndComments` from fitness. |
| `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/quality/no-console-log.ts` | **Source** for Phase 3 | 103 lines. Pure regex. Same `maskCommentsLines` dependency. References `CLAUDE.md Guardrails` — those references must be removed/replaced for opensip-tools. |

## Pre-Implementation Audit

Before Phase 0 begins, validate these assumptions:

- [ ] **No name collision.** Confirm `opensip-tools/fit/checks/no-focused-tests.mjs` does not already exist (verify at start of Phase 2).
- [ ] **No name collision.** Confirm `opensip-tools/fit/checks/no-console-log.mjs` does not already exist (verify at start of Phase 3).
- [ ] **No first-party name collision either.** Confirm `packages/fitness/checks-typescript/src/checks/testing/no-focused-tests.ts` and `packages/fitness/checks-typescript/src/checks/quality/no-console-log.ts` do NOT exist (grep showed they don't). If a first-party version exists when this plan starts, decide whether to retire one before adding the project-local — having both is confusing.
- [ ] **Existing checks pass.** Before Phase 1's CI step is added, confirm `pnpm fit` currently exits 0 on a clean working tree. If it doesn't, Phase 1 must establish the baseline FIRST or the initial CI run will fail on existing violations.
- [ ] **`isTestFile` is exported.** Confirm `import { isTestFile } from '@opensip-tools/fitness'` resolves (we verified it does at `packages/fitness/engine/src/index.ts` exports). Both new checks rely on it for test-file scoping.
- [ ] **`stripStringsAndComments` shape.** Confirm `stripStringsAndComments(content)` exists and returns the stripped string (it's exported from `packages/fitness/engine/src/index.ts`). Used to mask comments before regex scan so JSDoc examples don't trip the check.
- [ ] **CI checkout depth.** `.github/workflows/ci.yml:18` uses `actions/checkout@v4` with default fetch-depth (1). For GH Code Scanning, a single-commit checkout is fine (the service does the cross-run comparison). For a future SQLite-baseline restore approach, fetch-depth or an external artifact store may matter.
- [ ] **SARIF upload permissions.** GitHub Actions needs `security-events: write` permission for the `github/codeql-action/upload-sarif` step. Confirm the repo's default token permissions allow this or add `permissions:` block at the workflow level.
- [ ] **SQLite baseline ephemeral in CI.** `opensip-tools/.runtime/datastore.sqlite` is gitignored (`.gitignore: opensip-tools/.runtime/`). Each CI run starts with no baseline. This means `fit --gate-compare` alone cannot enforce ratcheting across runs — it has no historical state to compare against. The CI workflow in Phase 1 must either (a) save fresh baseline + export SARIF each run (Code Scanning is the ratchet) or (b) wait for a `fit-baseline-import` feature that doesn't exist yet.

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

`pnpm lint` runs ESLint and dependency-cruiser; both must be 0-error per CLAUDE.md "Before Committing". Phase-specific verification commands (e.g., `pnpm fit` to verify the dogfood loop, `pnpm test --filter checks-typescript` for per-pack tests) are listed in each phase file.
