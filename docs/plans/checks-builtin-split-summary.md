# checks-builtin split — execution summary

Date: 2026-05-14

## Outcome

Mechanical split of `@opensip-tools/checks-builtin` into two new packages:

- **`@opensip-tools/checks-typescript`** (new) — TypeScript/Node.js
  AST-driven checks. Version: `1.0.0`.
- **`@opensip-tools/checks-universal`** (existing, re-versioned) —
  cross-language regex/text/glob checks. Version bumped from `0.6.1`
  to `1.0.0` to reflect the breaking expansion of scope.

`@opensip-tools/checks-builtin/` deleted entirely (hard cutover, no
shim).

## Final counts (runtime, after `pnpm -r build`)

- `checks-typescript.checks.length`: **66 checks** across 60 display
  entries.
- `checks-universal.checks.length`: **92 checks** across 88 display
  entries (includes the two pre-existing checks `file-length-limit` and
  `no-todo-comments`).
- Combined: **158 distinct check exports**, 148 entries from the
  classification table after dropping the two top-level placeholder
  duplicates (see "Special cases" below).

Some files (e.g. `resilience/async-patterns.ts`,
`resilience/event-patterns.ts`, `resilience/recovery-patterns.ts`,
`resilience/service-patterns.ts`, `resilience/transaction-patterns.ts`,
`resilience/batch-operations.ts`, `resilience/error-code-registration.ts`,
`resilience/catch-clause-safety.ts`, `resilience/context-safety.ts`)
each export multiple `defineCheck` instances, which is why the runtime
count exceeds the file count.

## CLI dependency rewire

`packages/cli/package.json`:

- Removed `@opensip-tools/checks-builtin: workspace:*`.
- Added `@opensip-tools/checks-typescript: workspace:*` and
  `@opensip-tools/checks-universal: workspace:*`.

CLI source code carried no direct imports of `@opensip-tools/checks-builtin`
(decoupling Workstream A had already eliminated them). Three comments
mentioning `checks-builtin` remain in `packages/cli/src/commands/{fit,dashboard}.ts`
and `packages/core/src/{plugins,recipes,targets}/*.ts`; these are
historical context strings, not code references.

## Helpers — duplicated vs. moved

Generic file-detection / text helpers in the old `utils/` directory are
needed by both buckets. Per the brief (avoid circular deps, prefer
duplication over surgery on `core`), I copied them:

| Helper file | checks-typescript | checks-universal |
|---|---|---|
| `utils/source-analysis.ts` (`isCommentLine`) | git mv from checks-builtin | duplicated copy |
| `utils/test-helpers.ts` (`isTestFile`, `TEST_FILE_PATTERNS`) | git mv | duplicated copy |
| `utils/path-matching.ts` (`createPathMatcher`) | git mv | duplicated copy |
| `utils/ts-ast.ts` (`hasExportModifier`) | git mv | NOT needed (TS-only) |
| `utils/index.ts` | git mv (kept ts-ast export) | newly written (no ts-ast export) |

Sibling helpers stayed with their consumers:

| Helper | Bucket | Rationale |
|---|---|---|
| `quality/api/openapi-check-utils.ts` | checks-typescript | Imports `CheckViolation` only, but lives next to the openapi-* TS_AST checks. Currently dead-coded (no consumer beyond the barrel). |
| `quality/observability/observability-coverage/{analyzer,logger-detector,types}.ts` | checks-typescript | Imports `getSharedSourceFile` from `@opensip-tools/lang-typescript`. Dead-coded today (no check imports them) but kept to preserve structure. |
| `resilience/config-validation-helpers.ts` | checks-universal | Used by `cache-ttl-validation`, `dangerous-config-defaults`, `retry-config-validation` — all UNIVERSAL. |
| `resilience/sentry/sentry-helpers.ts` | checks-universal | Used by all seven `sentry-*` checks — all UNIVERSAL. |

No helper was moved into `@opensip-tools/core`.

## Special cases (overrides / classification calls)

1. **Top-level `no-eval.ts` + `no-console-log.ts` dropped.**

   The classification table listed both the top-level
   `packages/checks-builtin/src/checks/no-eval.ts` /
   `packages/checks-builtin/src/checks/no-console-log.ts` AND the
   subdirectory canonicals at `security/no-eval.ts` /
   `quality/code-structure/no-console-log.ts`. The top-level files were
   minimal early prototypes (single-pattern detection, placeholder UUID
   IDs `550e8400-...`, no longDescription, no fileTypes). The
   subdirectory versions are the production-ready definitions
   (multi-pattern, structured logger, `isCommentLine` filtering, real
   IDs, full metadata). Per the brief, I kept ONE of each — the
   subdirectory versions — and `git rm`'d the top-level placeholders.

   Both remaining checks live in `checks-universal` (correct
   classification — both are pure regex over file content).

2. **`stale-build-artifacts` slug had no display entry.** Listed in the
   classification table as UNIVERSAL but absent from every display map
   in the original `checks-builtin/src/display/`. Left without a display
   entry in the new `checks-universal` display map (kebab-to-title-case
   fallback applies). Not invented to satisfy the brief.

3. **Display entries with no live check.** The original
   `RESILIENCE_DISPLAY` referenced `error-handling-suite`, `no-empty-throw`,
   and `no-generic-error` — slugs that no source file defines. Dropped
   from both new display maps (they would shadow the kebab-to-title-case
   fallback for non-existent checks).

4. **`frontend-client-boundary-placement`.** The classification table
   abbreviates the slug as `client-boundary-placement`, but
   `quality/frontend/client-boundary-placement.ts` actually exports
   `slug: 'frontend-client-boundary-placement'`. The display map uses
   the real slug. The TS_AST classification is correct.

5. **`observability-coverage` subdirectory.** The three files in
   `quality/observability/observability-coverage/` (`analyzer.ts`,
   `logger-detector.ts`, `types.ts`) are helpers only re-exported via a
   barrel — no check imports them at runtime. They were not in the
   classification table. Moved to `checks-typescript` because they
   import `typescript` and `@opensip-tools/lang-typescript`. If they
   stay unused they're a candidate for deletion in a follow-up.

## Tests

- New `packages/checks-typescript/src/__tests__/checks.test.ts` —
  smoke test for the package's plugin contract (every check has slug,
  id, tags, valid analysisMode, run function; slugs and ids are
  unique).
- New `packages/checks-universal/src/__tests__/checks.test.ts` — same
  contract test, plus an existence check for `no-console-log` (which
  now lives in this package).
- Pre-existing `checks-universal` tests
  (`file-length-limit.test.ts`, `no-todo-comments.test.ts`) untouched.
- The old `packages/checks-builtin/src/__tests__/checks.test.ts` was
  removed alongside the rest of `checks-builtin/`.

No import paths in any other test file needed updating — the
decoupled CLI Workstream A had already cut every direct import of
`@opensip-tools/checks-builtin`.

## Verification

- `pnpm install`: clean (no errors, no deprecation surprises).
- `pnpm -r build` (turbo, all 15 workspace projects): **PASS**.
  - `checks-typescript build: Done`
  - `checks-universal build: Done`
  - `cli build: Done`
- `pnpm -r typecheck`: **PASS** for every package.
- `pnpm -r test`:
  - `checks-typescript`: 6 tests passed.
  - `checks-universal`: 15 tests passed (3 files).
  - `cli`: 150 tests passed (14 files) — including 21 e2e tests that
    exercise the full check-package auto-discovery path.
  - All other packages: passing.

## Working tree state

Dirty, uncommitted, as instructed. `git status` shows ~150 renames
(`R `) plus a handful of new files and the two `git rm`-ed top-level
duplicates. No unintended changes outside the targeted packages.
