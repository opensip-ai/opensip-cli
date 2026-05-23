---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-typescript"
package: "@opensip-tools/checks-typescript"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-typescript

## Summary

`@opensip-tools/checks-typescript` ships 66 TypeScript-AST-driven
fitness checks organized into five top-level categories
(`architecture`, `quality`, `resilience`, `security`, `testing`), with
quality further split into 8 sub-folders (`api`, `code-structure`,
`data-integrity`, `frontend`, `linting`, `observability`, `patterns`,
plus three checks at the category root). The pack barrel
(`src/index.ts`) follows the standard plugin contract:
`collectCheckObjects(allChecks)` produces `checks`, the merged
`CHECK_DISPLAY` map is re-exported as `checkDisplay`, and `metadata`
is a literal record. Layering is mostly clean — every check depends
only on `@opensip-tools/fitness`, `@opensip-tools/lang-typescript`,
`@opensip-tools/core` (via subpath imports for `errors` and `logger`),
the `typescript` compiler API, and Node built-ins. No imports of
`@opensip-tools/cli`, `@opensip-tools/contracts`, or sibling check
packs.

The pack is consistent in its outermost shape — every check is a
single `defineCheck({ ... })` with an `analyze` or `analyzeAll`
callback, no inheritance hierarchies, no class-based checks. But
under that uniform skin there are several real architectural
problems:

1. **Two giant resilience files mix unrelated checks.**
   `resilience/async-patterns.ts` is 1,266 lines and exports four
   independent checks (`detached-promises`, `no-unbounded-concurrency`,
   `no-raw-fetch`, `await-result-unwrap`) that share nothing beyond
   the `resilience` tag. `resilience/context-safety.ts` is 791 lines
   with two unrelated checks (`context-mutation-check`,
   `context-leakage`). Splitting them out would match the
   one-check-per-file convention used elsewhere and cut the largest
   `@fitness-ignore-file file-length-limits` exemption in the repo.

2. **A 300-entry false-positive whitelist is hard-coded inline.** The
   `KNOWN_SYNC_FUNCTIONS`, `KNOWN_SYNC_RECEIVERS`,
   `KNOWN_SYNC_RECEIVER_PATTERNS`, `KNOWN_SYNC_PREFIXES`,
   `KNOWN_SYNC_SUFFIXES`, `FIRE_AND_FORGET_PATTERNS`, and
   `FILE_SKIP_PATTERNS` constants in `async-patterns.ts` together
   total ~270 hand-curated names. They tune for a specific corpus
   (opensip / fastify / Pyroscope / OTel) and the file already has a
   recipe-config escape hatch (`additionalSyncFunctions`,
   `additionalSyncReceivers`, `additionalSyncPrefixes`) — the
   built-in defaults should be migrated into a recipe so users can
   ship their own names without editing this pack.

3. **AST helpers are reinvented per check rather than shared.**
   `lang-typescript/ast-utilities.ts` exports `parseSource`,
   `walkNodes`, `getSharedSourceFile`, `getIdentifierName`,
   `getPropertyChain`, `findCallExpressions`, `isInComment`, and
   others — but only the security-pillar checks
   (`sql-injection`, `input-sanitization`,
   `unsafe-secret-comparison`) and a handful of others use them.
   Most checks reimplement enclosing-function lookup,
   conditional-block detection, and async-modifier detection inline.
   `findEnclosingFunctionBody`, `getEnclosingFunctionName`,
   `isInsideConditionalBlock`, `findEnclosingScope`, and
   `findFunction` all walk `node.parent` to find the closest
   function-like ancestor; they should consolidate into a single
   shared helper in `lang-typescript`.

4. **Test-file detection is duplicated 10+ times inline.** The
   fitness package exports an `isTestFile(filePath)` helper that
   checks the canonical `.test.ts`/`.spec.ts`/`__tests__/`
   conventions. Most check files use it correctly, but at least 10
   re-implement the check inline (`filePath.includes('.test.') ||
   filePath.includes('.spec.') || filePath.includes('__tests__')`).
   These hand-rolled variants drift — some include `.spec.`,
   some don't; some include `__tests__/`, some include
   `__tests__`.

5. **Two import styles for the TS compiler.** 47 files do
   `import * as ts from 'typescript'` directly; 6 files
   (`security/sql-injection`, `security/input-sanitization`,
   `security/unsafe-secret-comparison`,
   `architecture/circular-import-detection`,
   `quality/observability/pii-exposure-in-logs`,
   `quality/patterns/stream-buffer-size-limits`) use the
   `ts` re-export from `@opensip-tools/fitness` (or
   `@opensip-tools/lang-typescript`). Pick one and enforce it.

The good news: there are no inheritance smells, no class-based check
systems, no Visitor-pattern frameworks built on top of the simple
`defineCheck` API, and no checks bypass the `defineCheck` framework.
Every check is a flat function-and-data module that returns
`CheckViolation[]`. The `analyze` callback shape is consistent
across the pack.

## Existing patterns (correct usage)

- **Plugin contract is honored.** `src/index.ts` exports `checks`,
  `checkDisplay`, and `metadata`, and uses `collectCheckObjects` to
  walk the namespace import. Display merging via four sub-files
  (`architecture.ts`, `quality.ts`, `resilience.ts`,
  `security-testing.ts`) keeps each map focused on its category and
  the merged map immutable via `Object.freeze`. The fallback to
  kebab-to-title-case via `getCheckDisplayName` is intentional —
  not every check needs a custom display entry.

- **Recipe-config-aware checks use `getCheckConfig` consistently.**
  `detached-promises`, `toctou-race-condition`,
  `throws-documentation`, and `null-safety` all follow the same
  shape: a typed `Config extends Record<string, unknown>`
  interface, a slug constant, and a `getCheckConfig<T>(SLUG)` call
  inside `analyze`. This is the right pattern.

- **Layering is clean.** Across 66 checks, the only third-party
  imports are `@opensip-tools/fitness`,
  `@opensip-tools/lang-typescript`, `@opensip-tools/core/errors`,
  `@opensip-tools/core/logger`, `typescript`, and Node built-ins.
  No imports of `@opensip-tools/cli`, `@opensip-tools/contracts`,
  `@opensip-tools/simulation`, or other check packs. The
  `package.json` `dependencies` list matches what's actually
  imported.

- **`getSharedSourceFile` is used uniformly.** AST-driven checks
  almost universally use `getSharedSourceFile(filePath, content)`
  from `@opensip-tools/lang-typescript`, which routes through the
  language adapter's parse cache. A single check (`security/sql-injection`)
  uses `parseSource` directly, but it's inside a
  `walkNodes` pipeline imported from the same package, so the AST
  parse path remains coherent.

- **Pure analyzer + `defineCheck` wrapper exists in one place.**
  `resilience/context-safety.ts` exports `analyzeContextMutation`
  as a pure function and tests it directly in
  `resilience/__tests__/context-safety.test.ts`. This is the right
  shape — but only one check follows it. Most checks inline the
  analysis inside `analyze:` and require an
  `ExecutionContext` to be unit-tested.

- **No inheritance, no classes for checks.** Every check is a flat
  `defineCheck({ ... })` block. `dispose-pattern-completeness` and
  `lifecycle-cleanup-enforcement` describe class-shape concerns but
  are themselves just function-and-data modules — they don't grow
  into mini-frameworks.

## Findings

### Two resilience files bundle unrelated checks under one slug-set

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/resilience/async-patterns.ts:1-1266`
    (4 checks: `detached-promises`, `no-unbounded-concurrency`,
    `no-raw-fetch`, `await-result-unwrap`)
  - `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts:1-791`
    (2 checks: `context-mutation-check`, `context-leakage`)
- **Pattern / principle:** Single Responsibility Principle (file
  scope); one-check-per-file is the convention everywhere else in
  this pack.
- **Status:** Existing.
- **Why it matters:** `async-patterns.ts` is the largest file in
  the pack (1,266 lines) and the only file with a high
  cognitive-complexity pragma. Its four checks share no helpers —
  `detached-promises` has its own 200-entry sync-call whitelist,
  `no-unbounded-concurrency` has its own bounded-pattern detector,
  `no-raw-fetch` has its own URL-skip list, and `await-result-unwrap`
  has its own regex. Co-locating them buys nothing and forces every
  test/CR diff that touches one check to scan the other three. The
  `// =====` banner comments inside the file are hand-rolled section
  separators that are a clear "this should be multiple files"
  signal.
- **Recommendation:** Split each check into its own file under
  `resilience/`. The barrel `resilience/index.ts` would still
  re-export them; only the storage shape changes. Same for
  `context-safety.ts` → `context-safety/context-mutation.ts` +
  `context-safety/context-leakage.ts` (or just two top-level
  resilience files). Drop the `@fitness-ignore-file
  file-length-limits` pragma when each file is below the threshold.

### Hard-coded false-positive whitelist for `detached-promises` is in the wrong place

- **Files / code:**
  `packages/fitness/checks-typescript/src/checks/resilience/async-patterns.ts:39-538`
  — `KNOWN_SYNC_FUNCTIONS` (~250 entries),
  `KNOWN_SYNC_RECEIVERS` (~50 entries),
  `KNOWN_SYNC_RECEIVER_PATTERNS` (~10 entries),
  `KNOWN_SYNC_PREFIXES` (~50 entries), `KNOWN_SYNC_SUFFIXES`,
  `FIRE_AND_FORGET_PATTERNS`, `FILE_SKIP_PATTERNS`. ~270 names
  total, ~500 lines of constants.
- **Pattern / principle:** Open-Closed Principle —
  consumer-extensible config (a recipe) should not require
  patching this pack to add a project-specific sync helper. The
  comments make this explicit (e.g. line 131: "opensip-specific
  OTel/error helpers are NOT defaults. They live in opensip's
  recipe").
- **Status:** Existing — partially mitigated. The check ALREADY
  reads `additionalSyncFunctions`, `additionalSyncReceivers`,
  `additionalSyncPrefixes` from the recipe (lines 554-562). What's
  missing is the migration of corpus-specific defaults out of the
  pack source.
- **Why it matters:** The pack is meant to be a public, generic
  TypeScript check pack. Right now, ~150 of the ~270 default names
  are "Pyroscope SDK", "Fastify decorators", "DBOS step .init",
  "OpenTelemetry propagation API" — not generic JS/TS sync APIs.
  Every project that doesn't use Pyroscope or DBOS pays for those
  whitelist entries (they bloat the file and may shadow real
  detached-promise bugs in other libraries with similarly named
  methods). The file has the largest amount of project-specific
  knowledge in the entire pack.
- **Recommendation:** Trim defaults to truly generic JS/TS
  built-ins (Array/String/Object/Math/JSON methods, `console.*`,
  Node `*Sync` family, `setTimeout`/`setImmediate`,
  `EventEmitter`). Move the framework-specific lists (Fastify,
  Pyroscope, OTel, DBOS, Vitest, Drizzle) into a published recipe
  shipped alongside the pack — the recipe author, not the check
  author, is the right owner of "what does my framework consider
  synchronous?"

### AST helpers are reinvented per-check; the shared lang-typescript helpers are underused

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/quality/stubbed-implementation-detection.ts:76-95`
    — `findEnclosingFunctionBody`
  - `packages/fitness/checks-typescript/src/checks/quality/stubbed-implementation-detection.ts:100-112`
    — `getEnclosingFunctionName`
  - `packages/fitness/checks-typescript/src/checks/quality/stubbed-implementation-detection.ts:118-138`
    — `isInsideConditionalBlock`
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/lifecycle-cleanup-enforcement.ts:68-85`
    — `findEnclosingScope`
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/silent-early-returns.ts:42-58`
    — `findFunction`
  - `packages/fitness/checks-typescript/src/checks/resilience/async-patterns.ts:567-584`
    — `isInAsyncContext`
  - `packages/fitness/checks-typescript/src/checks/quality/observability/observability-coverage/analyzer.ts:15-18`
    — `isAsync(node)` (only place it lives)
  - `packages/languages/lang-typescript/src/ast-utilities.ts` —
    DOES export `walkNodes`, `findCallExpressions`,
    `isInStringLiteral`, `isInComment`, `getIdentifierName`,
    `getPropertyChain`, `isLiteral`, but no enclosing-function
    helper.
- **Pattern / principle:** DRY (Don't Repeat Yourself) /
  Strategy + shared utility — checks should compose shared AST
  primitives, not reimplement the parent-walk for each variant.
- **Status:** Existing — partial. `lang-typescript` is the
  designated home for shared AST helpers and ~7 are exported, but
  the most common "find the enclosing function" / "is inside a
  conditional" / "does this node carry the async modifier"
  primitives haven't been promoted there.
- **Why it matters:** Every reinvention of the parent walk has
  slightly different semantics — `findEnclosingFunctionBody`
  returns `null` when the function has no Block body (arrow
  expression body), `findFunction` returns the function-like node
  itself, `findEnclosingScope` returns the SourceFile as a
  fallback. When a fix to one walk needs to be replicated across
  five files, it's easy to miss one. And new check authors copy
  the closest existing version, which propagates whichever subtle
  bug or feature was in the source they copied from.
- **Recommendation:** Add `findEnclosingFunction`,
  `findEnclosingFunctionBody`, `getEnclosingFunctionName`,
  `isInAsyncContext`, `isInsideConditionalBlock`, and `isAsync` to
  `@opensip-tools/lang-typescript/ast-utilities.ts` as a single
  pass. Update existing checks to import the shared versions.
  Document the canonical helpers in the pack-author guide.

### Test-file detection is duplicated inline 10+ times

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/quality/data-integrity/numeric-validation.ts`
    — `filePath.includes('.test.') || filePath.includes('__tests__')`
  - `packages/fitness/checks-typescript/src/checks/quality/data-integrity/financial-transaction-ordering.ts`
    — `filePath.includes('.test.') || filePath.includes('.spec.')`
  - `packages/fitness/checks-typescript/src/checks/quality/observability/no-hardcoded-correlation-id.ts`
    — `filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__')`
  - `packages/fitness/checks-typescript/src/checks/quality/observability/logger-event-name-format.ts`
    — same as above
  - `packages/fitness/checks-typescript/src/checks/quality/api/fastify-schema-coverage.ts`
    — `file.includes('.test.') || file.includes('.spec.')`
  - `packages/fitness/checks-typescript/src/checks/quality/api/fastify-route-validation.ts`
    — three-arm includes-chain inline
  - `packages/fitness/checks-typescript/src/checks/testing/mock-implementations-in-production.ts`
    — `filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/')`
  - `packages/fitness/checks-typescript/src/checks/architecture/missing-type-exports.ts`
    — `filePath.includes('.test.') || filePath.includes('__tests__')`
  - `packages/fitness/checks-typescript/src/checks/architecture/drizzle-orm-migration-guardrails.ts`
    — same inline check
  - `packages/fitness/checks-typescript/src/checks/resilience/async-patterns.ts:1126-1136`
    — bespoke 7-arm `endsWith('.test.ts'|'.test.tsx'|...)` chain
  - The fitness package exports a canonical `isTestFile(filePath)`
    helper, used by ~13 of the 66 check files.
- **Pattern / principle:** DRY; small shared utilities (`isTestFile`)
  should be applied uniformly.
- **Status:** Existing.
- **Why it matters:** The inline variants drift from
  `isTestFile`'s definition — some include `.spec.`, some don't;
  some treat `__tests__/` as a path segment vs.
  `__tests__` as a substring; some include `.tsx`, most don't.
  When a project has tests in `tests/` (no underscores) or
  `*.tests.ts` (plural), each check has a different blind spot.
  The bespoke 7-arm `endsWith` chain in `no-raw-fetch` is the
  most visible example — it's the only place that checks `.tsx`
  test files.
- **Recommendation:** Lint or codemod every inline
  `.includes('.test.')` chain to use `isTestFile(filePath)` from
  `@opensip-tools/fitness`. If `isTestFile` is missing a case the
  inline variants cover (e.g. `.spec.tsx`), broaden the canonical
  helper rather than leaving inline copies. Consider an ESLint
  rule that flags string-literal occurrences of `.test.` /
  `.spec.` / `__tests__` in this package and points at
  `isTestFile`.

### Inconsistent import path for the TypeScript compiler

- **Files / code:**
  - 47 files: `import * as ts from 'typescript'` (the dominant
    style)
  - `packages/fitness/checks-typescript/src/checks/security/sql-injection.ts:9`
    — `import { defineCheck, type CheckViolation, getASTLineNumber, ts } from '@opensip-tools/fitness'`
  - `packages/fitness/checks-typescript/src/checks/security/input-sanitization.ts:12`
    — same pattern
  - `packages/fitness/checks-typescript/src/checks/security/unsafe-secret-comparison.ts`
    — same pattern
  - `packages/fitness/checks-typescript/src/checks/architecture/circular-import-detection.ts`
    — same pattern
  - `packages/fitness/checks-typescript/src/checks/quality/observability/pii-exposure-in-logs.ts`
    — same pattern
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/stream-buffer-size-limits.ts`
    — has BOTH (imports from `@opensip-tools/fitness` and adds
    `import * as ts from 'typescript'` on the next line)
  - `lang-typescript/ast-utilities.ts:238` re-exports
    `export { ts }` for downstream consumers.
- **Pattern / principle:** Codebase consistency / one canonical
  way to do things.
- **Status:** Existing.
- **Why it matters:** Two ways to import the same module produce
  noisier diffs, complicates "where do I get `ts` from?" for new
  authors, and the dual-import in `stream-buffer-size-limits.ts`
  is an obvious copy-paste artifact. The `ts` re-export from
  `@opensip-tools/fitness` is also a layering concern — it makes
  the fitness package's API surface depend on the TypeScript
  compiler types, which couples non-TS consumers (e.g. the
  Java/Go/Python check packs that also import from fitness) to a
  compiler they don't use.
- **Recommendation:** Standardize on `import * as ts from 'typescript'`
  in this pack (the majority style). Drop the `ts` re-export from
  `@opensip-tools/fitness`, or move it to
  `@opensip-tools/lang-typescript` where it belongs. Update the
  6 outliers.

### Subpath imports of `@opensip-tools/core` violate the documented preference

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/quality/test-only-implementations.ts:12`
    — `import { ValidationError } from '@opensip-tools/core/errors'`
  - `packages/fitness/checks-typescript/src/checks/quality/unused-config-options.ts:9`
    — `import { logger } from '@opensip-tools/core/logger'`
  - `packages/fitness/checks-typescript/src/checks/quality/patterns/silent-early-returns.ts:8`
    — same
  - `packages/fitness/checks-typescript/src/checks/testing/mock-implementations-in-production.ts:8`
    — same
  - `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts:10`
    — same
- **Pattern / principle:** Project convention. From the
  workspace `CLAUDE.md`: "Subpath exports are strongly discouraged;
  prefer the package barrel. The exception is
  `@opensip-tools/core/languages/parse-cache.js` (used by language
  adapters)."
- **Status:** Existing.
- **Why it matters:** These five files import either `logger` or
  `ValidationError` from a subpath. `logger` and `ValidationError`
  are part of the core package's public API and are exported from
  the barrel; the subpath imports are vestigial. They make the
  pack's coupling to core's directory layout brittle (a
  reorganization in core would break this pack), and they
  violate the project's stated layering rule.
- **Recommendation:** Switch these five imports to the
  `@opensip-tools/core` barrel. Then add a dependency-cruiser or
  ESLint rule that disallows non-barrel imports of
  `@opensip-tools/core` in this pack (with the parse-cache
  documented exception).

### `duplicate-utility-functions` carries a 200-entry domain blocklist that should live in a recipe

- **Files / code:**
  `packages/fitness/checks-typescript/src/checks/quality/code-structure/duplicate-utility-functions.ts:56-280`
  — `DOMAIN_SPECIFIC_FUNCTIONS` set, ~140 hand-curated function
  names with explanatory comments referencing internal modules
  (`opensip's foundation/utils`, "DBOS step .init", "Pyroscope SDK",
  "fitness check selectors", "Foundation hosts two
  correlation-ID providers" …).
- **Pattern / principle:** Open-Closed Principle — same shape as
  the `detached-promises` whitelist. Generic check, project-specific
  blocklist.
- **Status:** Existing — but with NO recipe escape hatch (unlike
  `detached-promises`, which at least reads from `getCheckConfig`).
- **Why it matters:** This check is meant to flag duplication
  patterns generic to TypeScript — `formatDate`, `parseEnvInteger`,
  `validateEmail`, `isPlainObject`, etc. — and the fix for false
  positives is to teach a project's recipe which names are
  intentionally domain-specific. Today the only fix is to edit
  this file. The list cites internal opensip modules by name
  (e.g. `formatDuration` at line 230, `getRemoteUrl` at 272,
  `sanitizeForPrompt` at 250) — it's clearly an opensip-specific
  exception list that leaked into a public pack.
- **Recommendation:** Replace `DOMAIN_SPECIFIC_FUNCTIONS` with a
  `getCheckConfig<DuplicateUtilityFunctionsConfig>(SLUG)` block
  that reads `additionalDomainSpecificFunctions: string[]`. Trim
  the in-file defaults to genuinely generic identifiers (e.g.
  `getConfig` is plausibly generic;
  `getCurrentCorrelationId` is not) and migrate the rest into
  the opensip recipe. Same template as `detached-promises`.

### Display map missing entries for 6 architecture checks (intentional kebab-fallback or forgotten?)

- **Files / code:**
  - Slugs in `architecture/` checks: `tsconfig-extends-validation`,
    `circular-import-detection`, `missing-type-exports`,
    `module-coupling-fan-out`, `package-json-exports-field`,
    `drizzle-orm-migration-guardrails`. None of these appear in
    `display/architecture.ts`.
  - `display/architecture.ts:8-13` has only 4 entries:
    `contracts-schema-consistency`, `di-static-inject-usage`,
    `typed-inject-scope-mismatch`, `unused-modules`.
- **Pattern / principle:** Consistency / least-surprise.
- **Status:** Existing.
- **Why it matters:** The kebab-to-title-case fallback is
  intentional per the docstring, so this isn't broken — but the
  asymmetry is jarring. `quality/` has display entries for 46 of
  47 checks (missing only `stubbed-implementation-detection`,
  see below); `architecture/` has 4 of 10. A reader can't tell
  whether each missing entry is intentional (fallback is fine) or
  a forgotten addition.
- **Recommendation:** Either backfill display entries (with
  domain-appropriate icons) so the map is exhaustive, or add a
  comment to `display/architecture.ts` clarifying the policy:
  "We only override slugs whose kebab-to-title-case rendering is
  ambiguous or technically misleading; everything else falls back."

### `stubbed-implementation-detection` has display entry but `incomplete-regex-escaping` slug does not match its display key

- **Files / code:**
  - `display/quality.ts:47` — `'stubbed-implementation-detection': ['🔍', 'Stubbed Implementation Detection']`
  - `checks/quality/stubbed-implementation-detection.ts:27-28`
    declares the slug via `const CHECK_SLUG = 'stubbed-implementation-detection'`
    and uses it indirectly (`slug: CHECK_SLUG`) — this is fine,
    but the slug-extraction shell script-level comparisons missed
    it. Note that `display/quality.ts:28` lists
    `'incomplete-regex-escaping'`, and the check at
    `checks/quality/incomplete-regex-escaping.ts` declares the
    matching slug — those are aligned.
- **Pattern / principle:** Consistency in slug definition style.
- **Status:** Existing — minor.
- **Why it matters:** The rest of the pack uses literal slug
  strings inside `defineCheck({ slug: 'foo-bar' })`. Only
  `stubbed-implementation-detection` (and a couple others) hoists
  the slug into a `CHECK_SLUG` constant. Both styles are valid;
  the inconsistency just makes regex-grepping for slugs trickier
  (a slug-audit script would miss the constant-style ones unless
  it's smart about TS).
- **Recommendation:** Pick one style. Either inline all slugs
  (matches the majority) or hoist all slugs to constants (cleaner
  for self-referential pragmas like `// @fitness-ignore-file
  stubbed-implementation-detection`). If you hoist, also add
  the slug constant to a per-check exports list so tooling can
  introspect.

### Frontend `no-inline-functions.ts` carries a `file-length-limits` exemption it doesn't need

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/quality/frontend/no-inline-functions.ts:1`
    — `// @fitness-ignore-file file-length-limits -- Complex module
    with tightly coupled logic; refactoring would risk breaking changes`
  - File is only 175 lines.
- **Pattern / principle:** Suppress only what's actually
  failing; don't carry pragmas for cargo-cult comfort.
- **Status:** Existing.
- **Why it matters:** Boilerplate exemption pragmas accumulate
  across the pack — at least 15 files exempt themselves from
  `file-length-limits`, several with the same generic comment
  ("Complex module with tightly coupled logic; refactoring would
  risk breaking changes"). Some are legitimate (the 1,266-line
  `async-patterns.ts`). `no-inline-functions.ts` at 175 lines is
  not legitimate. Stale exemptions hide which files actually have
  a length problem and which don't.
- **Recommendation:** Audit every `@fitness-ignore-file
  file-length-limits` pragma in this pack. Drop the ones whose
  files are well below the threshold. The remaining set should
  be the actual outliers worth addressing.

### One check is unit-tested via the pure-function pattern; 65 are not

- **Files / code:**
  - `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts:316-362`
    exports `analyzeContextMutation(content, filePath)` as a pure
    function alongside the `defineCheck` wrapper.
  - `packages/fitness/checks-typescript/src/checks/resilience/__tests__/context-safety.test.ts`
    tests `analyzeContextMutation` directly.
  - The remaining 65 checks inline their analysis inside
    `analyze:` and require an `ExecutionContext` to be exercised.
  - The pack has 12 test files total, mostly broad `all-checks-execute`
    smoke tests rather than per-check coverage.
- **Pattern / principle:** Pure function + thin wrapper —
  separates the algorithm from the framework binding so tests
  don't need to stand up the framework.
- **Status:** Existing.
- **Why it matters:** Testability is the principal lever for
  reducing false positives in this pack (every finding above —
  whitelists, AST helpers, test-file detection — is tuning to
  reduce FPs). Tests that go through the framework are slow and
  awkward to write per-case. Testing the pure analyzer is
  trivial: pass content + path, assert violations. The pack has
  one check at this shape and it's the one that has been hardened
  the most against FPs.
- **Recommendation:** Make pure-analyzer-export the documented
  default for new checks. Refactor 5-10 of the highest-FP-risk
  checks (`detached-promises`, `null-safety`,
  `stubbed-implementation-detection`,
  `error-handling-quality`, `context-leakage`) to follow this
  shape and add per-case tests. The reward is faster iteration
  on every future FP report.

## Non-findings considered and dismissed

- **"Each check is a class" smell — not present.** Every check is
  a flat `defineCheck({ ... })` literal. There are no inheritance
  hierarchies, no abstract-Check classes, no Visitor frameworks
  on top of `defineCheck`. Composition over inheritance is
  honored.

- **`async-patterns.ts` mixes 4 unrelated checks but does NOT
  share a base class — also dismissed as "fat checks".** Each
  check is its own `defineCheck`; they merely happen to live in
  the same file. The recommendation is "split files", not
  "split checks".

- **`stubbed-implementation-detection` runs three sub-detectors
  in one `analyze` — not a fat check.** All three sub-detectors
  (empty-object stub, Promise.resolve stub, hardcoded-stub return)
  are aspects of the same single concern: "this looks like an
  unfinished implementation that will fail at runtime." A single
  slug is correct. Same story for `error-handling-quality` —
  catch blocks and Result-pattern handlers are both "silent
  errors", and the unification is documented as replacing two
  legacy checks (`no-empty-catch`, `error-swallowing-boolean`).

- **`CHECK_DISPLAY` regex/icon bloat — not a concern.** Every
  display entry is a tuple `[icon, displayName]`; there are no
  embedded format strings or lookup callbacks. The map is large
  (~60 entries) but it's a flat literal that's `Object.freeze`d
  at module load. The category split into 4 sub-files keeps each
  individual map readable. Adding a new check requires one new
  line in the right sub-file.

- **`COMMON_PROPERTY_NAMES` and similar small whitelists — not
  the same as the `KNOWN_SYNC_*` finding above.** Sets like the
  20-entry `COMMON_PROPERTY_NAMES` in `unused-config-options.ts`,
  the 11-entry `LIFECYCLE_METHOD_NAMES` in
  `stubbed-implementation-detection.ts`, and the 8-entry
  `PRIMITIVE_TYPES` set are small enough and generic enough to
  be reasonable in-source defaults. Only the 270-entry
  `KNOWN_SYNC_*` and 140-entry `DOMAIN_SPECIFIC_FUNCTIONS` lists
  are large and project-specific enough to merit recipe-config
  migration.

- **Subpath import `@opensip-tools/core/languages/parse-cache.js` —
  not a violation.** This is the documented exception in
  `CLAUDE.md`. The pack does not use it directly; only
  `lang-typescript/ast-utilities.ts` does, which is correct.

- **Three "no-empty-catch" / "error-swallowing-boolean" /
  "error-handling-quality" overlap — already resolved.**
  `error-handling-quality.ts:299-303` documents that this check
  replaces the prior two, and the replaced checks are no longer
  in the pack. Good.

- **Hard-coded path checks (`/cli/`, `/scripts/`, `/llm/`,
  `/dbos/steps/`) — used sparingly and intentionally.** They appear
  in only a handful of checks (`no-raw-fetch`,
  `unused-config-options`, `context-leakage`) and each has a
  defensible reason documented in comments. Migrating these to
  recipe config would be over-engineering for the present
  volume.
