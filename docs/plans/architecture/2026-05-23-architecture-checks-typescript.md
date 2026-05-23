---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-typescript"
package: "@opensip-tools/checks-typescript"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-checks-typescript.md
related-plan: ./2026-05-22-plan-layer-4-check-packs.md
---
# Architecture audit (delta) — @opensip-tools/checks-typescript

## Summary

Wave 4 landed the bulk of the Group D plan. The two fat resilience
files are split (one check per file), seven AST helpers now live in
`@opensip-tools/lang-typescript` and most check files consume them,
`isTestFile` adoption is complete (zero inline test-file detection
remaining), the `KNOWN_SYNC_*` and `DOMAIN_SPECIFIC_FUNCTIONS`
blocklists are trimmed and recipe-config-aware, all `@opensip-tools/core`
imports are barrel imports backed by a new dep-cruiser rule, and the
`typescript` import style is unified at `import * as ts from 'typescript'`
across all 51 source files. Display map is exhaustive across all five
categories. The pack is in materially better shape than at last audit.

Two findings from the prior audit remain, both carry-overs that the
plan flags as long-running rather than single-CR work: F11 (pure-analyzer
test pattern adopted by only two checks now — `analyzeContextMutation`
and `analyzeFileLength` from `checks-universal`) and a tail of two
inline AST-helper reinventions that the Wave 4 sweep didn't catch
(`findFunction` in `silent-early-returns.ts`, `isAsyncFunction` in
`async-waterfall-detection.ts`). Net-new findings are minor and are
all P3 hygiene: stale pre-Wave-4 references in test-file comments and
`logger.debug` event names, a redundant import line in
`stream-buffer-size-limits.ts`, and a stale "in one place" claim in the
prior audit that is now "in two places". No new SOLID, layering, or
GoF concerns surfaced.

## Status of prior findings

### F1 — Two resilience files bundle unrelated checks (Phase D1) — CLOSED

`resilience/async-patterns.ts` (1,266 lines, 4 checks) and
`resilience/context-safety.ts` (791 lines, 2 checks) are gone. The new
layout matches the one-check-per-file convention used throughout the
pack:

- `resilience/detached-promises.ts` (706 lines)
- `resilience/no-unbounded-concurrency.ts` (122 lines)
- `resilience/no-raw-fetch.ts` (112 lines)
- `resilience/await-result-unwrap.ts` (83 lines)
- `resilience/context-mutation.ts` (394 lines)
- `resilience/context-leakage.ts` (404 lines)

The barrel `resilience/index.ts:1-6` re-exports all six. Each file
owns its check-local constants. The `@fitness-ignore-file
file-length-limits` pragma now appears only on `detached-promises.ts`,
which still legitimately exceeds the threshold (636 non-empty lines,
soft limit 400, hard limit 800; see `checks-universal/file-length-limit.ts:11-12`).

### F2 — `KNOWN_SYNC_*` / `FIRE_AND_FORGET` / `FILE_SKIP` defaults too project-specific (Phase D4) — CLOSED

`detached-promises.ts:42-200` now contains ~150 generic JS/TS sync
identifiers (Array, String, Object, Math, JSON, console, Node `*Sync`,
EventEmitter, Date, timers). The framework-specific entries
(Pyroscope, Fastify decorators, OTel propagation, DBOS step `.init`,
Vitest, Drizzle) are gone. The fileheader doc-block at lines 5-15
explicitly states the policy: "framework-specific helpers belong in a
recipe's `checks.config['detached-promises']` block." `getCheckConfig`
is consumed at line 336, with `additionalSyncFunctions`,
`additionalSyncReceivers`, `additionalSyncPrefixes` augmenting the
defaults at lines 337-342.

### F3 — AST helpers reinvented per check (Phase D2) — MOSTLY CLOSED

Seven helpers shipped in `packages/languages/lang-typescript/src/ast-utilities.ts:268-369`:
`findEnclosingFunction`, `findEnclosingFunctionBody`,
`getEnclosingFunctionName`, `findEnclosingScope`, `isAsync`,
`isInAsyncContext`, `isInsideConditionalBlock`. Adoption is good:
`stubbed-implementation-detection.ts:23-28` consumes three;
`lifecycle-cleanup-enforcement.ts:12` consumes `findEnclosingScope`;
`detached-promises.ts:19` consumes `isInAsyncContext`;
`observability-coverage/analyzer.ts:6` consumes `isAsync`. Two inline
copies remain (see MISSED below).

### F4 — Test-file detection duplicated inline 10+ times (Phase D3) — CLOSED

A grep for `filePath.includes('.test.')` / `.includes('.spec.')` /
`.includes('__tests__')` across `src/checks/` returns zero hits.
`isTestFile` is consumed in 22 sites including all the previously
flagged ones (`numeric-validation`, `financial-transaction-ordering`,
`no-hardcoded-correlation-id`, `logger-event-name-format`,
`fastify-schema-coverage`, `fastify-route-validation`,
`mock-implementations-in-production`, `missing-type-exports`,
`drizzle-orm-migration-guardrails`, the new `no-raw-fetch.ts:61`).
The bespoke 7-arm `endsWith` chain in the old `no-raw-fetch` is gone.

### F5 — Inconsistent `typescript` import style (Phase D5) — CLOSED

`grep -rc "import \* as ts from 'typescript'"` returns 51 files; zero
files import `ts` from `@opensip-tools/fitness` or
`@opensip-tools/lang-typescript`. The dual-import in
`stream-buffer-size-limits.ts` is gone — see NET-NEW N1 for a smaller
remnant. (The `ts` re-export from fitness/lang-typescript is a Layer
3 concern owned by Phase D3 of that plan; not visible from this pack.)

### F6 — Subpath imports of `@opensip-tools/core` (Phase D6) — CLOSED

All five sites (`test-only-implementations.ts:12`,
`unused-config-options.ts:9`, `silent-early-returns.ts:8`,
`mock-implementations-in-production.ts:7`, `context-mutation.ts:10`,
plus the new `context-leakage.ts:6`) now import from the
`@opensip-tools/core` barrel. The new dep-cruiser rule
`check-pack-no-core-subpath` at `.dependency-cruiser.cjs:198-210`
forbids regressions for any `packages/fitness/checks-` package, with
only `parse-cache.js` whitelisted.

### F7 — `DOMAIN_SPECIFIC_FUNCTIONS` blocklist hard-coded inline (Phase D4) — CLOSED

`duplicate-utility-functions.ts:31-34` declares
`DuplicateUtilityFunctionsConfig.additionalDomainSpecificFunctions`,
the in-file `DOMAIN_SPECIFIC_FUNCTIONS` set at lines 78-101 is
trimmed to ~15 generic names (`getConfig`, `getLogger`,
`isPlainObject`, `formatDate`, etc.) — internal opensip names like
`getCurrentCorrelationId`, `formatDuration`, `getRemoteUrl`,
`sanitizeForPrompt` are gone — and the merge is performed via
`getCheckConfig<DuplicateUtilityFunctionsConfig>('duplicate-utility-functions')`
at line 108.

### F8 — Display map missing 6 architecture entries (Phase D7) — CLOSED

`display/architecture.ts:8-19` now has 10 entries covering every check
in `checks/architecture/`: `circular-import-detection`,
`contracts-schema-consistency`, `di-static-inject-usage`,
`drizzle-orm-migration-guardrails`, `missing-type-exports`,
`module-coupling-fan-out`, `package-json-exports-field`,
`tsconfig-extends-validation`, `typed-inject-scope-mismatch`,
`unused-modules`. Resilience map at `display/resilience.ts:8-15` has
the six post-split entries. Symmetric.

### F9 — Slug-definition-style inconsistency (Phase D7) — CLOSED

A grep for `CHECK_SLUG`, `SLUG = '`, or any uppercase identifier
appearing on a `slug:` line returns zero hits in `src/checks/`. Every
check uses inline literals: `slug: 'detached-promises'`,
`slug: 'context-mutation-check'`, etc.

### F10 — Stale `file-length-limits` pragmas (Phase D7) — CLOSED

Only four files carry the pragma now, and all four legitimately
exceed the soft limit when measured by non-empty lines:

- `async-waterfall-detection.ts` — 418 non-empty / 492 total
- `duplicate-utility-functions.ts` — 456 non-empty / 514 total
- `throws-documentation.ts` — 551 non-empty / 611 total
- `detached-promises.ts` — 636 non-empty / 706 total

The cargo-cult exemption on `frontend/no-inline-functions.ts` (175
lines) called out by F10 has been dropped. No false-positive pragmas
remain.

### F11 — Pure-analyzer + thin wrapper adoption (deferred per plan) — UNCHANGED

Still one check uses the pattern:
`context-mutation.ts:319` exports `analyzeContextMutation`,
`resilience/__tests__/context-mutation.test.ts:13` consumes it
directly. Plan defers this to opportunistic refactoring; no Wave 4
sweep was scheduled. Status quo.

## Net-new findings

### N1 — Redundant `stripStringsAndComments` import in stream-buffer-size-limits

- **F#:** N1
- **Severity:** P3
- **Where:** `packages/fitness/checks-typescript/src/checks/quality/patterns/stream-buffer-size-limits.ts:10-11`
- **What:** SRP / consistency. Two consecutive imports from the same
  package on adjacent lines:
  ```ts
  import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
  import { stripStringsAndComments } from '@opensip-tools/fitness'
  ```
  The previous fitness/typescript dual import was the F5 issue; this
  is a smaller copy-paste artifact left over from the cleanup. The
  ESLint flat config does not enforce import merging.
- **Why:** Cosmetic, but it's the kind of drift that compounds. The
  rest of the pack imports all fitness symbols on a single line.
- **Recommendation:** Merge into one statement:
  `import { defineCheck, stripStringsAndComments, type CheckViolation } from '@opensip-tools/fitness'`.
  Optionally enable `import/no-duplicates` (already in the workspace
  ESLint config but possibly not catching same-package multi-imports
  in this package's flat config).

### N2 — Stale `async-patterns` / `context-safety` references in test comments and event names

- **F#:** N2
- **Severity:** P3
- **Where:**
  - `src/__tests__/coverage-extension-3.test.ts:50` — comment "the
    second check in context-safety.ts"
  - `src/__tests__/coverage-extension-3.test.ts:191` —
    "detached-promises (resilience/async-patterns)"
  - `src/__tests__/coverage-extension-3.test.ts:245` —
    "no-unbounded-concurrency (resilience/async-patterns)"
  - `src/__tests__/coverage-extension-5.test.ts:4` — fileheader
    "array-validation, async-patterns, and other sub-90% checks"
  - `src/checks/resilience/context-mutation.ts:84,110,163,271,321` —
    `evt: 'fitness.checks.context_safety.…'` (5 occurrences)
  - `src/checks/resilience/context-leakage.ts:373` —
    `evt: 'fitness.checks.context_safety.context_leakage_analyze'`
- **What:** Documentation drift. The source-of-truth files for these
  comments and event names no longer exist. The `evt` strings are
  user-visible — they appear in structured log output and any
  observability sink that ingests them.
- **Why:** Minor on its own, but the `evt` names are semi-stable
  identifiers that downstream log queries / dashboards key off. They
  should converge with the new file names: `fitness.checks.context_mutation.*`
  and `fitness.checks.context_leakage.*`. The test-file comments are
  pure documentation cleanup.
- **Recommendation:** Single sweep CR. Rename the 6 event strings and
  fix the 4 test-file comments. Verify no log-aggregator dashboards
  pin against `context_safety.*` before merging — if any do, add an
  alias or stage the rename.

### N3 — Two inline AST helpers survived the Wave 4 sweep

- **F#:** N3
- **Severity:** P3
- **Where:**
  - `src/checks/quality/patterns/silent-early-returns.ts:42-58` —
    `findFunction(node)` walks `node.parent` to find `FunctionDeclaration`,
    `MethodDeclaration`, `ArrowFunction`. Equivalent to
    `findEnclosingFunction` from `lang-typescript/ast-utilities.ts:268`,
    minus `ConstructorDeclaration` and `FunctionExpression` cases.
  - `src/checks/quality/patterns/async-waterfall-detection.ts:61-71` —
    `isAsyncFunction(node)` returns true when `node` is a function-like
    AND has the `async` modifier. The shared `isAsync` at
    `lang-typescript/ast-utilities.ts:332-335` performs exactly the
    second half via `canHaveModifiers`/`getModifiers`; combined with
    the function-like type guard the local copy can be a one-liner.
- **What:** DRY / shared utility. F3 from the prior audit listed five
  inline copies; Wave 4 caught three (in `stubbed-implementation-detection`,
  `lifecycle-cleanup-enforcement`, the four checks formerly in
  `async-patterns.ts`). These two slipped through.
- **Why:** Same rationale as the prior F3: each reinvention drifts
  on edge cases. `findFunction` here doesn't include constructors or
  function expressions; the canonical `findEnclosingFunction` does. A
  user-defined arrow inside a constructor would not match the local
  helper but would match the shared one.
- **Recommendation:** Replace the two inline copies with imports from
  `@opensip-tools/lang-typescript`. `findFunction` → drop, use
  `findEnclosingFunction` (semantics broaden slightly — confirm with
  the existing test fixtures). `isAsyncFunction` →
  `(node) => isFunctionLike(node) && isAsync(node)` if you need both
  predicates, or just `isAsync(node)` if the call sites already know
  the node is function-like (they do — see line 67's branch
  enumeration). Consider also exporting `isFunctionLike` from
  `lang-typescript` (it's currently a private internal helper at line
  254).

### N4 — `context-mutation.ts:339` carries a `slow-regex` ESLint disable for a literal-only regex

- **F#:** N4
- **Severity:** P3
- **Where:** `src/checks/resilience/context-mutation.ts:339-340`:
  ```ts
  // eslint-disable-next-line sonarjs/slow-regex -- bounded input: patternName is a short literal like 'ctx.*=' / 'context.*=' authored above in MUTATION_DETECTORS, not attacker input
  const rootName = match.detector.patternName.replace(/\..*$/, '')
  ```
  The regex `/\..*$/` is greedy. The justification is correct (the
  input is a literal authored 200 lines up), but the simpler fix is
  to write `match.detector.patternName.split('.')[0]` and drop the
  pragma. No regex, no rule violation, no comment to maintain.
- **What:** Operational hygiene. Pragmas with substantial justifications
  accumulate; each one is a small reading tax for the next maintainer.
- **Why:** Tiny, but exists.
- **Recommendation:** Replace with `split('.')[0]` (or
  `match.detector.patternName.slice(0, match.detector.patternName.indexOf('.'))`
  if the dot is not guaranteed). Drop the disable comment.

## Missed (gaps in the prior audit / plan)

### M1 — `async-waterfall-detection.ts` was not on the F3 site list

The prior F3 listed five inline AST-helper sites; Phase D2 references
those plus "any other sites surfaced during the sweep". The
`isAsyncFunction` helper at `async-waterfall-detection.ts:61-71`
fits the F3 pattern (function-like detection + modifier check) but
was not enumerated. Wave 4 did not catch it. Captured as N3 above.

### M2 — Pure-analyzer claim in the prior audit is now stale

Prior summary item 6 ("Pure analyzer + `defineCheck` wrapper exists in
one place") referenced `resilience/context-safety.ts`'s
`analyzeContextMutation`. The file has been split; the pure-analyzer
export now lives at `context-mutation.ts:319`. Same shape, different
home. The prior plan's deferred section already accounts for the
broader F11 ("pure-analyzer adoption is a long-running quality
lever"); no plan-text correction is needed. Note for tracking only.

### M3 — `evt:` event name drift is not a documented review step

Wave 4 was framed as a structural / file-layout split. The
operational impact of file renames on `logger.debug({ evt: 'fitness.checks.<file>.…' })`
strings was not part of the checklist (as far as I can tell from the
plan text — there's no mention of `evt:` strings, log-name-format
checks, etc., in Phase D1 or D7). The `context_safety.*` event names
in `context-mutation.ts` and `context-leakage.ts` (six call sites
total) now misname their host module. Captured as part of N2; flagged
here so future split phases include an `evt:` rename pass in the
checklist.

### M4 — No follow-up on slug self-reference for split files

`context-mutation.ts:370` declares `slug: 'context-mutation-check'`
(note: `-check` suffix), inherited from the pre-split file where the
sibling check was `context-leakage` (no `-check` suffix). This is a
slug-versus-filename mismatch and an asymmetry between the two
sibling checks (`context-mutation-check` vs. `context-leakage`). Both
are pre-existing and the plan did not call for a slug rename — slug
changes would be breaking for users with `--check context-mutation-check`
in CI. Calling it out here only because the post-split context makes
the asymmetry more visible than it was inside `context-safety.ts`.
Suggest deferring (slug aliases + deprecation are a release-management
concern, not a Wave-4-followup concern) but documenting in
`display/resilience.ts` why the two slugs differ.

## Overall

Wave 4 closed 9 of 11 prior findings outright (F1–F10), made
substantial progress on F3 (now N3 with two stragglers), and left F11
in the deferred state per plan. New findings are P3 hygiene at the
margin: a duplicate import line, six stale `evt:` strings, four stale
test comments, two surviving AST-helper inline copies, and one
unnecessary regex/pragma pair. None are load-bearing; none affect
layering, plugin contract, public API, or output correctness. The pack
is closer to the one-check-per-file, helpers-in-lang-typescript,
recipe-driven-blocklist target than at any prior audit.

The dependency-cruiser rule `check-pack-no-core-subpath` is the
highlight of the wave: it pins the F6 fix as enforcement rather than
convention, so future drift surfaces in CI rather than in the next
audit. Same template would close N3's drift if applied to inline
AST-helper definitions, but the rule shape (forbidding local
function declarations whose name shadows a `lang-typescript` export)
is too sharp for a dep-cruiser rule and too situational for a unit
test. A documented checklist in the contributor guide is probably the
right level of enforcement.

No new SOLID, GoF, layering, or plugin-contract issues surfaced.
Sequence the four N# items as a single hygiene CR; M# items are
either tracking notes (M1, M2, M3) or release-management considerations
(M4) and do not need code changes in this cycle.
