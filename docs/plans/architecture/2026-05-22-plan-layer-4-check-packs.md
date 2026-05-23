---
status: current
last_verified: 2026-05-22
title: "Layer 4 (check packs) — remediation plan"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-checks-typescript.md
  - ./2026-05-22-architecture-checks-universal.md
  - ./2026-05-22-architecture-checks-python.md
  - ./2026-05-22-architecture-checks-go.md
  - ./2026-05-22-architecture-checks-java.md
  - ./2026-05-22-architecture-checks-cpp.md
related-plans:
  - ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Layer 4 (check packs) — remediation plan

## Summary

Layer 4 is the six fitness check packs that sit on top of `@opensip-tools/fitness`
and the language adapters: `checks-typescript` (66 checks), `checks-universal`
(92 checks), and the four small language-specific packs (`checks-python`,
`checks-go`, `checks-java`, `checks-cpp`, each shipping one check). The
layer is in broadly good shape — every pack honours the plugin contract
(`checks` + `checkDisplay` + `metadata`), layering is clean (no imports of
`cli`, `contracts`, simulation, or sibling check packs), and there are no
inheritance-heavy frameworks growing on top of `defineCheck`. The audits
together surfaced 31 findings across the six packs, but the bulk of them
are duplications, drift, and template-the-template opportunities rather
than load-bearing defects.

The exception is **checks-cpp F1**: the clang-tidy parser captures the file
path in regex group 1 but never reads it, so every clang-tidy violation
emits with `filePath = ''`. That collapses per-file grouping in the
dashboard and SARIF export and breaks `@fitness-ignore-file` exemptions
for the only C++ check we ship. This is a P0 correctness bug and is the
first phase of the plan. Beyond it, the dominant cohort-wide drift is
the `metadata.version` literal (stale at `0.6.1` in four packs and `1.0.0`
in two while `package.json` is `1.3.1`), the line-oriented regex-list
scanner reinvented ~13 times in `checks-universal`, and three
overlapping-check pairs in `checks-universal` (TODO detectors,
test-modifier detectors, package-audit checks) that produce duplicate
findings on the same line of source unless users carefully turn checks
off. None of these are bugs today; they are tax that will compound as
the packs grow.

## Sequencing rationale

The plan is sequenced as four groups:

- **Group A — Correctness fixes (P0).** The clang-tidy parser bug. Stand-alone,
  small, must land first because it is the only finding in the layer that
  produces incorrect output for a shipped check.
- **Group B — Cohort-wide cleanups (P2).** Hygiene across the four small
  packs: `metadata.version`/`metadata` shape, duplicate test files,
  test-side `lang-java` reach. Done together so the pack template
  converges in one CR per concern.
- **Group C — `checks-universal` restructuring (P1).** The largest pack
  carries the largest user-facing duplication. Resolving the three
  overlap clusters (TODO, test-modifier, package-audit) is independent
  of the umbrella-fat-check split (`no-legacy-code`,
  `comment-quality`, `directive-audit`) and both are independent of
  the `defineRegexListCheck` adoption phase, which depends on
  Layer 3 introducing the helper. Layout fixes (misclassified
  security checks, helper re-exports, display map gaps) are cheap and
  ride at the end.
- **Group D — `checks-typescript` restructuring (P1/P2).** Splitting the
  two fat resilience files is a structural change and should land
  before the AST-helper consolidation (so the helpers are extracted
  from one-check-per-file files, not 1,200-line ones). Recipe
  migration of the two large project-specific blocklists, the import
  consistency cleanups, and the display/exemption hygiene complete
  the pack.

P0 = the clang-tidy file-path bug. P1 = overlapping detectors in
`checks-universal` and the two fat resilience files in
`checks-typescript` (real user-facing duplication and
one-check-per-file invariant violations). P2 = consistency cleanups
(`metadata.version` drift, duplicate test files, missing display
entries, import-style drift, stale exemption pragmas).

## Group A — Correctness fixes (P0)

### Phase A1 — Fix clang-tidy parser to capture file path and column

**Closes:** checks-cpp F1.

**Why first:** Every clang-tidy violation lands with `filePath = ''`,
which collapses dashboard/SARIF per-file grouping and silently breaks
`@fitness-ignore-file <slug>` exemptions for the only C++ check the
project ships. This is the only correctness bug in the layer.

**Files:**

- `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts` —
  in `parseClangTidyOutput`, read `match[1]` (file path) and
  `match[3]` (column). Resolve the path: absolute paths pass
  through; relative paths join via `path.resolve(cwd, rawPath)`.
  Mirror `parseSemgrepOutput`'s shape at
  `packages/fitness/checks-universal/src/checks/security/semgrep-scan.ts:79`.
  Set `violation.filePath` and `violation.column` on each emitted
  `CheckViolation`.
- `packages/fitness/checks-cpp/src/__tests__/parse.test.ts` — add
  assertions for `filePath` (absolute and relative inputs) and
  `column`.
- `packages/fitness/checks-cpp/src/__tests__/clang-tidy.test.ts` —
  same.

**Out of scope for this phase:** the Windows-path / structured-output
hardening described in checks-cpp F2; that is a separate evolution
captured in the Deferred section. This phase is the smallest possible
fix that restores per-file grouping.

## Group B — Cohort-wide cleanups (small packs)

### Phase B1 — Eliminate `metadata.version` drift across the four small packs

**Closes:** checks-go F1, checks-python F1, checks-java F3, checks-cpp
(implicit cohort drift; the cpp barrel carries the same stale literal),
and the same drift in `checks-typescript` and `checks-universal` whose
barrels still read `1.0.0` against a `1.3.1` `package.json`.

**Approach:** Replace each pack's hand-maintained `metadata` literal
with a `package.json` import under Node16 ESM JSON resolution. The
fitness package may host a thin `definePackMetadata({ pkg })` helper
to standardize the shape — coordinate with the Layer 3 fitness plan
(this helper is small enough to land in Layer 4 directly if Layer 3
hasn't introduced it).

**Files:**

- `packages/fitness/checks-go/src/index.ts`
- `packages/fitness/checks-python/src/index.ts`
- `packages/fitness/checks-java/src/index.ts`
- `packages/fitness/checks-cpp/src/index.ts`
- `packages/fitness/checks-typescript/src/index.ts`
- `packages/fitness/checks-universal/src/index.ts`
- Each pack's `tsconfig.json` if `resolveJsonModule` isn't already
  enabled.

All six barrels switch to the same shape: `import pkg from
'../package.json' with { type: 'json' }` and
`metadata = { name: pkg.name, version: pkg.version, description: pkg.description }`.
This is a single CR touching six files and removes a category of
silent drift.

### Phase B2 — Consolidate duplicate per-check test files in the small packs

**Closes:** checks-python F2, checks-go F2 (both call out the same
near-duplicate `analyze.test.ts` + `<check-name>.test.ts` pair,
~70% overlapping `it()` cases targeting the same pure analyzer).

**Approach:** Merge each pair into the file named after the source
(`no-bare-except.test.ts`, `no-fmt-print.test.ts`,
`no-printstacktrace.test.ts`). Keep `run.test.ts` in each pack
unchanged — those exercise the framework wrapper and cover a real
gap. Pull unique cases from the deleted file into the kept file.

**Files:**

- Delete: `packages/fitness/checks-python/src/__tests__/analyze.test.ts`
- Delete: `packages/fitness/checks-go/src/__tests__/analyze.test.ts`
- Optional, after Phase B3 lands: deletion of the duplicate Java
  test file falls out naturally.
- Update: each surviving `<check-name>.test.ts` absorbs missing
  cases.

### Phase B3 — Realign `checks-java` test surface and dependency manifest

**Closes:** checks-java F1, checks-java F2.

**Approach:** Drop the test-side `import { stripComments, stripStrings }
from '@opensip-tools/lang-java/strip'` and rewrite that test either
(a) using comment-free / string-free fixtures (Go-pack convention),
or (b) driving false-positive coverage through
`noPrintStackTrace.run(cwd, ...)` in the existing `run.test.ts`. With
the test-side import gone, move `@opensip-tools/lang-java` from
`dependencies` to `devDependencies`, or drop it entirely if the
content-filter runs through the framework's `applyContentFilter`
dispatch (which it does — the CLI registers the Java adapter at
boot).

**Files:**

- `packages/fitness/checks-java/src/__tests__/no-printstacktrace.test.ts` —
  remove the `lang-java/strip` import and rewrite affected cases.
- `packages/fitness/checks-java/package.json` — move
  `@opensip-tools/lang-java` to `devDependencies` or remove.
- `packages/fitness/checks-java/src/__tests__/run.test.ts` — extend
  with comment/string false-positive fixtures if option (b) is
  chosen.

### Phase B4 — Trim the small-pack barrel template

**Closes:** checks-go F3 (and the same shape in the other small packs
that re-export the named check alongside the `checks` array).

**Approach:** After Phase B1 has standardized `metadata` to a
package.json-derived value, audit each small-pack barrel for the
named re-export (`export { noFmtPrint } from …`) that the plugin
loader doesn't need (the loader picks up the check via the `checks`
array). Decide one shape for the cohort: either keep the named
re-export everywhere as a documented part of the public API, or
drop it everywhere. The audit does not block on this — pick one
and apply uniformly across all four single-check packs.

**Files:**

- `packages/fitness/checks-{go,python,java,cpp}/src/index.ts`

## Group C — `checks-universal` restructuring

### Phase C1 — Resolve TODO/FIXME detector overlap

**Closes:** checks-universal F1 (three checks that all fire on `// TODO` lines).

**Approach:** Pick one canonical scanner. Recommended split per the
audit:

- Keep `no-todo-comments` as the cross-language regex scanner
  (`scope.languages = []`).
- Fold `quality/code-structure/todo-comments` into `no-todo-comments`
  (drop the TS-only variant; the cross-language one already covers
  it).
- Promote `comment-quality`'s AI-metadata and process-artifact
  rules out into `no-ai-attribution` and `no-process-artifacts` (each
  a single rule), and delete the `comment-quality` umbrella.

**Files:**

- Delete: `packages/fitness/checks-universal/src/checks/quality/code-structure/todo-comments.ts`
- Delete: `packages/fitness/checks-universal/src/checks/quality/code-structure/comment-quality.ts`
- Add: `packages/fitness/checks-universal/src/checks/quality/code-structure/no-ai-attribution.ts`
- Add: `packages/fitness/checks-universal/src/checks/quality/code-structure/no-process-artifacts.ts`
- Update: `packages/fitness/checks-universal/src/checks/quality/code-structure/index.ts`
- Update: `packages/fitness/checks-universal/src/display/quality.ts`
- Update: `packages/fitness/checks-universal/src/checks/no-todo-comments.ts`
  to absorb any unique cases from the deleted TS variant.

### Phase C2 — Resolve test-modifier detector overlap

**Closes:** checks-universal F2 (`no-focused-tests`, `no-skipped-tests`,
and the umbrella `no-test-only-skip` all fire on `it.only` / `it.skip`).

**Approach:** Keep the SRP-faithful split: retain
`no-focused-tests` (`.only`, `fit`, `fdescribe`) and
`no-skipped-tests` (`.skip`, `xit`, `xdescribe`, `xtest`); delete
the umbrella `no-test-only-skip`, porting its
`concurrent.only/skip` and Playwright `test.describe.only/skip`
patterns into the two surviving checks.

**Files:**

- Delete: `packages/fitness/checks-universal/src/checks/testing/no-test-only-skip.ts`
- Update: `packages/fitness/checks-universal/src/checks/testing/no-focused-tests.ts`
  — port `concurrent.only`, `test.describe.only` patterns.
- Update: `packages/fitness/checks-universal/src/checks/testing/no-skipped-tests.ts`
  — port `concurrent.skip`, `test.describe.skip` patterns.
- Update: `packages/fitness/checks-universal/src/checks/testing/index.ts`
- Update: `packages/fitness/checks-universal/src/display/security-testing.ts`
- The `createPathMatcher` helper at `src/utils/path-matching.ts`
  should remain — its sole consumer was `no-test-only-skip`; either
  port the consumer or check whether the surviving two checks want it.

### Phase C3 — Resolve package-audit overlap and rename

**Closes:** checks-universal F8 (`security-scan-suite` vs
`dependency-security-audit` vs `semgrep-scan` overlap; the first two
both shell out to the same package-manager audit).

**Approach:** Keep the better-implemented `security-scan-suite`,
rename it to `dependency-vulnerability-audit` (drop "suite" until it
actually composes multiple tools), delete the older
`dependency-security-audit`. Leave `semgrep-scan` alone — it's a
distinct tool.

**Files:**

- Delete: `packages/fitness/checks-universal/src/checks/quality/dependency-security-audit.ts`
- Rename: `packages/fitness/checks-universal/src/checks/quality/security-scan-suite.ts`
  → `packages/fitness/checks-universal/src/checks/security/dependency-vulnerability-audit.ts`
  (also moves it to the right category — see Phase C5).
- Update slug from `security-scan-suite` →
  `dependency-vulnerability-audit`. The slug change is breaking for
  any user who has put it in `--check` flags or recipes; document
  in the release notes.
- Update: `packages/fitness/checks-universal/src/checks/quality/index.ts`,
  `packages/fitness/checks-universal/src/checks/security/index.ts`,
  `packages/fitness/checks-universal/src/display/quality.ts`,
  `packages/fitness/checks-universal/src/display/security-testing.ts`.

### Phase C4 — Split the umbrella checks

**Closes:** checks-universal F3 (`no-legacy-code`, `comment-quality`
already handled in Phase C1, `directive-audit`).

**Approach:** Two surviving umbrella files:

- `no-legacy-code` → split into `no-deprecated-tags`,
  `no-compatibility-layer-names`, `no-temporary-workarounds`. Drop
  the version-check, shim-adapter, and backwards-compat-comment
  sub-rules — the audit flags them as weak heuristics with high
  false-positive risk.
- `directive-audit` → keep as one check but extract
  `parseTypeScriptDirectives`, `parseESLintDirectives`,
  `parseFitnessDirectives`, `parseSemgrepDirectives` to top-level
  helper modules. (The audit accepts keeping it as a single check
  because the four directive grammars are strongly related; the
  fix is to remove the 200-line-each inline grammars from the check
  file.)

**Files:**

- Delete: `packages/fitness/checks-universal/src/checks/quality/no-legacy-code.ts`
- Add: `packages/fitness/checks-universal/src/checks/quality/no-deprecated-tags.ts`
- Add: `packages/fitness/checks-universal/src/checks/quality/no-compatibility-layer-names.ts`
- Add: `packages/fitness/checks-universal/src/checks/quality/no-temporary-workarounds.ts`
- New helper module(s) under
  `packages/fitness/checks-universal/src/checks/documentation/_directives/`
  (TypeScript / ESLint / fitness / semgrep parsers).
- Update: `packages/fitness/checks-universal/src/checks/documentation/directive-audit.ts`
  to call the extracted parsers.
- Update: `packages/fitness/checks-universal/src/checks/quality/index.ts`,
  `packages/fitness/checks-universal/src/display/quality.ts`.

### Phase C5 — Layout and metadata cleanup

**Closes:** checks-universal F5 (helper re-exported through resilience
barrel), F6 (security checks under `quality/`), F7 (4 missing display
entries), F8 severity-string drift in remaining checks (the
`comment-quality` deletion in C1 absorbs two of the three; the
`no-legacy-code` deletion in C4 absorbs the third — but if any new
shape needs the lowercase fix, address it here).

**Approach:**

- Move `dependency-vulnerability-audit` (the renamed
  `security-scan-suite`) into `security/` (covered structurally by
  Phase C3; this phase confirms the barrel/display/category updates
  land). Keep `dependency-security-audit` deleted.
- Drop `export * from './config-validation-helpers.js'` from
  `packages/fitness/checks-universal/src/checks/resilience/index.ts`.
  The helper file remains in place; consumers continue to import it
  via relative path. (Alternative: move
  `config-validation-helpers.ts` to a `src/checks/_helpers/` folder
  and update consumer relative imports.)
- Audit `packages/fitness/checks-universal/src/checks/resilience/sentry/index.ts`
  for the same shape — if `sentry-helpers.ts` is barrel-re-exported,
  drop that line too.
- Add display entries to
  `packages/fitness/checks-universal/src/display/{architecture,quality,security-testing}.ts`
  for `file-length-limit` (`📏`), `no-todo-comments` (`📝`),
  `heavy-import-detection` (`📦`), `stale-build-artifacts` (`🏚️`).
  Final icon glyphs are the maintainer's call; the names are the
  load-bearing change.
- In any remaining check that declares
  `severity: 'ERROR' | 'WARNING'` internally and lowercases at
  emission, change the internal type to lowercase
  `'error' | 'warning'`. After Phase C1 and C4 land, only
  `semgrep-scan` keeps the uppercase shape (justified — it mirrors
  the wire format).

### Phase C6 — Adopt `defineRegexListCheck` (depends on Layer 3 plan)

**Closes:** checks-universal F4 (~13 reimplementations of the
"for line; for pattern; if match push violation" loop).

**Prerequisite:** Layer 3 plan — the Layer 3 remediation must
introduce a `defineRegexListCheck` (or `defineLineScanner`) Template
helper in `@opensip-tools/fitness`. See
`./2026-05-22-plan-layer-3-tools-and-lang.md`. This phase does not
start until that helper has shipped and is documented.

**Approach:** Sweep the 13 sites in `checks-universal` (and audit
checks-typescript for parallel cases — the four checks in
`async-patterns.ts` and `duplicate-utility-functions.ts` are not
straight regex-list scanners but several quality checks may be) and
rewrite each to a `defineRegexListCheck({ patterns, options })`
declaration. Sites identified in the audit:

- `quality/code-structure/no-console-log.ts` (already uses the
  per-pattern UUID model that should become the helper's default)
- `quality/no-window-alert.ts`
- `quality/patterns/performance-anti-patterns.ts`
- `security/no-hardcoded-secrets.ts`
- `security/no-eval.ts`
- `testing/no-skipped-tests.ts` (post-C2)
- `testing/no-focused-tests.ts` (post-C2)
- `architecture/docker-best-practices.ts`
- `architecture/heavy-import-detection.ts`
- The new `no-deprecated-tags`, `no-compatibility-layer-names`,
  `no-temporary-workarounds` produced by Phase C4
- The new `no-ai-attribution`, `no-process-artifacts` produced by
  Phase C1

**Outcome:** Each site collapses to ~30 lines of declaration plus a
shared kernel for `lastIndex` reset, comment-skip, test-file-skip,
and per-match emission. Behavioural drift between the sites
disappears. The per-pattern UUID + sub-slug model from
`no-console-log.ts` becomes the helper's default.

## Group D — `checks-typescript` restructuring

### Phase D1 — Split fat resilience files

**Closes:** checks-typescript F1.

**Approach:** Break the two files that violate the
one-check-per-file invariant elsewhere in the pack:

- `resilience/async-patterns.ts` (1,266 lines, four checks) →
  `resilience/detached-promises.ts`,
  `resilience/no-unbounded-concurrency.ts`,
  `resilience/no-raw-fetch.ts`,
  `resilience/await-result-unwrap.ts`.
- `resilience/context-safety.ts` (791 lines, two checks) →
  `resilience/context-mutation.ts` + `resilience/context-leakage.ts`
  (or a `context-safety/` sub-folder if shared helpers warrant it).

Each new file owns its own check-local constants (whitelists,
patterns, regex). The barrel `resilience/index.ts` re-exports the
new modules. Drop the `@fitness-ignore-file file-length-limits`
pragma from `async-patterns.ts` once each new file is below the
threshold.

**Files:**

- `packages/fitness/checks-typescript/src/checks/resilience/async-patterns.ts` (delete)
- `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts` (delete or shrink to one check)
- New files per the split above
- `packages/fitness/checks-typescript/src/checks/resilience/index.ts`
- `packages/fitness/checks-typescript/src/__tests__/...` — if any
  smoke test imports from the deleted barrel paths, update it.

### Phase D2 — Move AST helpers to `lang-typescript`

**Closes:** checks-typescript F3.

**Prerequisite:** Phase D1 (so the helpers are extracted from
single-purpose files, not from the 1,266-line bundle).

**Approach:** Promote the reinvented walks to
`@opensip-tools/lang-typescript/ast-utilities.ts`:

- `findEnclosingFunction(node)`
- `findEnclosingFunctionBody(node)`
- `getEnclosingFunctionName(node)`
- `findEnclosingScope(node)` (returns nearest function or SourceFile)
- `isInAsyncContext(node)`
- `isAsync(node)`
- `isInsideConditionalBlock(node)`

Pick canonical semantics (the audit notes the existing variants
disagree on arrow-body, conditional-block boundaries, etc.) and
document them in the helper JSDoc.

**Files:**

- `packages/languages/lang-typescript/src/ast-utilities.ts` — add the
  helpers and unit tests.
- Sites consuming the new helpers (delete the inline copies):
  - `packages/fitness/checks-typescript/src/checks/quality/stubbed-implementation-detection.ts`
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/lifecycle-cleanup-enforcement.ts`
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/silent-early-returns.ts`
  - `packages/fitness/checks-typescript/src/checks/resilience/detached-promises.ts` (post-D1)
  - `packages/fitness/checks-typescript/src/checks/quality/observability/observability-coverage/analyzer.ts`
  - Any other sites surfaced during the sweep.
- Update the pack-author guide (CLAUDE.md or contributor docs) to
  point new check authors at the canonical helpers.

### Phase D3 — Replace inline test-file detection with `isTestFile`

**Closes:** checks-typescript F4.

**Approach:** Codemod (or manual sweep — only ~10 sites) every
`filePath.includes('.test.')` / `.spec.` / `__tests__` chain in this
pack to `isTestFile(filePath)` from `@opensip-tools/fitness`. If any
inline variant catches a case `isTestFile` does not (e.g. `.spec.tsx`,
the 7-arm `endsWith` chain in `no-raw-fetch`), broaden the canonical
helper rather than leaving inline copies.

**Files:**

- `packages/fitness/checks-typescript/src/checks/quality/data-integrity/numeric-validation.ts`
- `packages/fitness/checks-typescript/src/checks/quality/data-integrity/financial-transaction-ordering.ts`
- `packages/fitness/checks-typescript/src/checks/quality/observability/no-hardcoded-correlation-id.ts`
- `packages/fitness/checks-typescript/src/checks/quality/observability/logger-event-name-format.ts`
- `packages/fitness/checks-typescript/src/checks/quality/api/fastify-schema-coverage.ts`
- `packages/fitness/checks-typescript/src/checks/quality/api/fastify-route-validation.ts`
- `packages/fitness/checks-typescript/src/checks/testing/mock-implementations-in-production.ts`
- `packages/fitness/checks-typescript/src/checks/architecture/missing-type-exports.ts`
- `packages/fitness/checks-typescript/src/checks/architecture/drizzle-orm-migration-guardrails.ts`
- `packages/fitness/checks-typescript/src/checks/resilience/no-raw-fetch.ts` (post-D1)
- `packages/fitness/engine/src/...` — if `isTestFile` needs broadening
  to absorb all inline cases, that change lands here.
- Optional: an ESLint rule under
  `packages/fitness/checks-typescript/eslint.config.mjs` that
  flags string-literal `.test.` / `.spec.` / `__tests__` in this
  package and points at `isTestFile`.

### Phase D4 — Migrate large project-specific blocklists to recipe config

**Closes:** checks-typescript F2 (the 270-entry `KNOWN_SYNC_*` /
`FIRE_AND_FORGET_PATTERNS` / `FILE_SKIP_PATTERNS` block in
`detached-promises`), checks-typescript F7 (the 200-entry
`DOMAIN_SPECIFIC_FUNCTIONS` block in `duplicate-utility-functions`).

**Approach:**

- `detached-promises` (now its own file post-D1): trim the in-file
  defaults to genuinely generic JS/TS sync APIs (Array, String,
  Object, Math, JSON, `console.*`, Node `*Sync` family,
  `setTimeout`/`setImmediate`, `EventEmitter`). Move framework-specific
  entries (Fastify decorators, Pyroscope SDK, OTel propagation, DBOS
  step `.init`, Vitest, Drizzle) into a recipe shipped alongside
  the pack — likely under
  `packages/fitness/checks-typescript/recipes/` or via the
  example/opensip recipe. The check already reads
  `additionalSyncFunctions`, `additionalSyncReceivers`,
  `additionalSyncPrefixes` from `getCheckConfig`, so the wiring is
  in place.
- `duplicate-utility-functions`: add the same recipe-config escape
  hatch (`getCheckConfig<DuplicateUtilityFunctionsConfig>(SLUG)`
  reading `additionalDomainSpecificFunctions: string[]`). Trim
  in-file defaults to genuinely generic identifiers; move
  opensip-specific entries (`getCurrentCorrelationId`,
  `formatDuration`, `getRemoteUrl`, `sanitizeForPrompt`, etc.) to
  the same recipe.

**Files:**

- `packages/fitness/checks-typescript/src/checks/resilience/detached-promises.ts` (post-D1)
- `packages/fitness/checks-typescript/src/checks/quality/code-structure/duplicate-utility-functions.ts`
- New or updated recipe files (location depends on whether the pack
  ships its own recipe directory or whether the example recipe in
  the workspace `opensip-tools/fit/recipes/` absorbs them).

### Phase D5 — Standardize `typescript` import style and drop the `ts` re-export

**Closes:** checks-typescript F5.

**Approach:** Pick `import * as ts from 'typescript'` (the dominant
style — 47 files). Update the 6 outliers
(`security/sql-injection`, `security/input-sanitization`,
`security/unsafe-secret-comparison`, `architecture/circular-import-detection`,
`quality/observability/pii-exposure-in-logs`,
`quality/patterns/stream-buffer-size-limits`) to drop the
`ts`-from-fitness import and use the direct module import.

Then drop the `ts` re-export from `@opensip-tools/fitness` (it
shouldn't be there — it couples non-TS check packs to a compiler
they don't use). If `lang-typescript/ast-utilities.ts` still
re-exports `ts`, that is acceptable because `lang-typescript` is
the canonical home for the TS compiler dependency in the layer.

This phase is partially Layer 3 work (the fitness package change),
but the call sites are Layer 4 — coordinate with the Layer 3 plan
or land the Layer 4 sweep first and the fitness drop second.

**Files:**

- 6 outlier files in `packages/fitness/checks-typescript/src/checks/...`
- `packages/fitness/engine/src/index.ts` (or wherever `ts` is
  re-exported) — drop the re-export.

### Phase D6 — Switch checks-typescript subpath imports to the `@opensip-tools/core` barrel

**Closes:** checks-typescript F6.

**Approach:** Five sites import from `@opensip-tools/core/errors` or
`@opensip-tools/core/logger` — the workspace convention is barrel
imports (the only documented exception is
`@opensip-tools/core/languages/parse-cache.js`). Switch them to
`import { ValidationError } from '@opensip-tools/core'` /
`import { logger } from '@opensip-tools/core'`. After the switch,
add a dependency-cruiser or ESLint rule that disallows non-barrel
`@opensip-tools/core` imports in this pack (with the parse-cache
exception).

**Files:**

- `packages/fitness/checks-typescript/src/checks/quality/test-only-implementations.ts`
- `packages/fitness/checks-typescript/src/checks/quality/unused-config-options.ts`
- `packages/fitness/checks-typescript/src/checks/quality/patterns/silent-early-returns.ts`
- `packages/fitness/checks-typescript/src/checks/testing/mock-implementations-in-production.ts`
- `packages/fitness/checks-typescript/src/checks/resilience/context-mutation.ts`
  (post-D1; may have moved file)
- `.dependency-cruiser.cjs` — add the rule.

### Phase D7 — Display map, slug-style, and exemption-pragma hygiene

**Closes:** checks-typescript F8 (architecture/ display map gaps),
checks-typescript F9 (slug-definition-style inconsistency),
checks-typescript F10 (stale `file-length-limits` exemptions).

**Approach:**

- **Display map.** Either backfill display entries for the six
  unrepresented architecture checks
  (`tsconfig-extends-validation`, `circular-import-detection`,
  `missing-type-exports`, `module-coupling-fan-out`,
  `package-json-exports-field`, `drizzle-orm-migration-guardrails`)
  with appropriate icons, or add a comment to
  `display/architecture.ts` documenting the policy ("only override
  slugs whose kebab-to-title-case rendering is ambiguous"). Pick
  one and apply consistently across all four display sub-files.
- **Slug style.** Pick literal slugs inside
  `defineCheck({ slug: 'foo-bar' })` (matches the majority) or
  hoist all slugs to `const CHECK_SLUG = 'foo-bar'` (cleaner for
  self-referential pragmas). Sweep the pack for the chosen shape.
- **Exemption pragmas.** Audit every
  `@fitness-ignore-file file-length-limits` pragma in the pack.
  Drop the ones whose files are below the threshold (e.g.
  `frontend/no-inline-functions.ts` at 175 lines). Keep
  legitimate exemptions where the file is genuinely large after
  Phase D1 ran.

**Files:**

- `packages/fitness/checks-typescript/src/display/architecture.ts`
  (and the other three sub-files if backfilling).
- Affected check files for slug-style consistency.
- Files with stale `@fitness-ignore-file file-length-limits`
  pragmas (run a search after D1 lands).

## Deferred

The following findings are explicitly out of scope and tracked for a
future cycle.

- **checks-cpp F2 — adopt `clang-tidy --export-fixes=<yaml>` and
  parse YAML.** The audit recommends this as the durable shape (mirrors
  `parseSemgrepOutput`), but it is an evolution and requires extending
  `CheckViolation` (or a new related-locations field) to carry notes
  and fix replacements. Today's regex parser works for simple cases
  once Phase A1 fixes the file-path bug. Revisit as a separate
  workstream alongside any `CheckViolation` schema changes.
- **checks-cpp F3 — clang-tidy `note:` lines.** Three options in the
  audit (update JSDoc to "drops notes"; append to `suggestion`; adopt
  `-export-fixes`). Bundle with the F2 evolution rather than
  half-fixing now. Until then, the JSDoc should be edited as part of
  Phase A1 to say "notes are dropped" so the documented contract
  matches the implementation.
- **checks-cpp F4 — `QUIET_ARGS` constant.** Micro-style, deferred
  until the pack grows a second clang-tidy-backed check.
- **checks-python F3 — pack-existence cost-benefit.** Audit's
  recommendation is "no change". Revisit only if Python check growth
  stalls and the pack still has ≤2 checks after another release
  cycle.
- **checks-typescript pure-analyzer test pattern adoption.** The
  audit's eleventh observation (one check uses pure-analyzer +
  framework wrapper, 65 do not) is a long-running quality lever, not
  a single-CR cleanup. Refactor 5–10 high-FP-risk checks
  (`detached-promises`, `null-safety`,
  `stubbed-implementation-detection`, `error-handling-quality`,
  `context-leakage`) opportunistically as they need other work; do
  not run a separate sweep.
- **`checks-universal` 16-barrel `index.ts` flattening.** The audit
  notes this is more nesting than strictly needed but the structure
  mirrors the category directory layout 1:1, which is intuitive for
  a 92-check pack. No change recommended.
