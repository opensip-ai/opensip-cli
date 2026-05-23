---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-universal"
package: "@opensip-tools/checks-universal"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-universal

## Summary

`@opensip-tools/checks-universal` is the largest pack in the
repository: 92 cross-language fitness checks across 6 top-level
categories (`architecture`, `documentation`, `quality`, `resilience`,
`security`, `testing`) plus two checks at the package root
(`file-length-limit`, `no-todo-comments`). The pack barrel
(`src/index.ts`) follows the standard plugin contract — `checks` is
collected via `collectCheckObjects(allChecks)`, `checkDisplay` exposes
the merged display map, and `metadata` is a literal record. Layering
is clean: every check imports only from `@opensip-tools/fitness`,
`@opensip-tools/core/logger`, or Node builtins. There are no leaks
into `@opensip-tools/cli`, `@opensip-tools/contracts`, or sibling
check packs.

For its size the pack is in surprisingly good shape: ~13 different
checks are line-oriented regex scanners, but each is a self-contained
`defineCheck` block with a local `PATTERNS` array, so the duplication
is mechanical and recognizable rather than tangled. Sentry checks are
the only sub-domain that has factored out shared helpers
(`sentry-helpers.ts`), and they do it cleanly.

The findings cluster around three real architectural concerns:

1. **Overlapping checks with the same surface area.** Three TODO/FIXME
   detectors and three test-modifier (`.only`/`.skip`) detectors all
   claim production scope simultaneously, so a project gets duplicate
   findings unless it carefully turns checks off. The largest
   "umbrella" checks (`no-legacy-code`, `comment-quality`,
   `directive-audit`) are also fat single checks that each bundle
   3-9 sub-rules under one slug.
2. **A missing "regex-list scanner" template.** ~13 checks reimplement
   the same loop ("for each line; for each pattern in PATTERNS; if
   match, push violation"). Each reinvention has slightly different
   handling for comments, sub-slugs, and severity. Promoting this to
   a `defineRegexListCheck` helper in `@opensip-tools/fitness` would
   compress hundreds of lines of code and unify behavior.
3. **Misplaced or misclassified files.** A few items are filed
   counter-intuitively: `dependency-security-audit` and
   `security-scan-suite` live under `quality/` despite being security
   checks; `config-validation-helpers.ts` is a helper module
   re-exported through the resilience barrel and is filed alongside
   real checks rather than under a `_helpers/` folder; four real
   checks (`file-length-limit`, `heavy-import-detection`,
   `no-todo-comments`, `stale-build-artifacts`) are missing
   `CHECK_DISPLAY` entries.

None of these are bugs — every check works in isolation and the
plugin contract is honored. They are duplications and coupling that
will compound as the pack grows.

## Existing patterns (correct usage)

- **Plugin contract is honored.** `src/index.ts` exports `checks`,
  `checkDisplay`, and `metadata` per the FitPluginExports contract
  used by all `@opensip-tools/checks-*` packages, and uses
  `collectCheckObjects` to walk the barrel.
- **Layering is clean.** Across all 92 checks the only third-party
  imports are `@opensip-tools/fitness`, `@opensip-tools/core/logger`,
  `node:fs`, and `node:path`. No imports of `@opensip-tools/cli`,
  `@opensip-tools/contracts`, `@opensip-tools/simulation`, or other
  check packs (apart from `no-test-only-skip` reusing the local
  `createPathMatcher`, and `__tests__` files reaching back to source).
- **Pure analyzer + `defineCheck` wrapper.** `file-length-limit.ts`
  and `no-todo-comments.ts` both export their pure
  `analyzeFileLength` / `analyzeTodoComments` functions independently
  of the `Check` wrapper, so unit tests don't need an
  `ExecutionContext`. `no-hardcoded-secrets.ts` does the same with
  `analyzeHardcodedSecrets`. This is the right shape and should be
  the template — but most of the other checks inline their analysis
  inside `analyze:` and aren't independently testable.
- **`contentFilter` is used correctly where needed.**
  `no-console-log`, `no-eval`, `no-todo-comments`, `no-hardcoded-secrets`,
  `no-skipped-tests`, `no-focused-tests`, `no-test-only-skip`,
  `no-stub-tests`, `no-window-alert` declare
  `contentFilter: 'strip-strings'`; checks that intentionally need
  comments or string literals (`comment-quality`, `directive-audit`,
  `fitness-ignore-hygiene`, `dependency-security-audit`) declare
  `contentFilter: 'raw'`. The meta-check `no-raw-regex-on-code`
  enforces this discipline reflexively, which is itself a tidy use of
  the framework on the framework.
- **Scope declarations are honest about cross-language vs TS-only.**
  `file-length-limit` and `no-todo-comments` declare
  `scope: { languages: [], concerns: [] }` (truly cross-language and
  cross-concern). Most other checks correctly narrow to
  `languages: ['typescript']` and a concern set
  (`['backend', 'frontend', 'cli']`, etc.) so the scope-resolver
  applies them only to relevant targets. There is no "scope: ['ts']
  but actually only useful for backend" drift.
- **Sentry sub-pack is well-factored.**
  `resilience/sentry/sentry-helpers.ts` exposes `hasSentryUsage`,
  `hasSentryInit`, and `extractSentryInitBlock`; each Sentry check
  (`sentry-dsn-configured`, `sentry-environment-set`,
  `sentry-pii-scrubbing`, `sentry-release-set`, `sentry-sample-rate`,
  `sentry-source-maps`, `sentry-error-boundary`) calls the helper
  rather than re-extracting the init block. This is the model the
  rest of the pack should follow when checks share a parsing kernel.
- **`createPathMatcher` is a tidy small abstraction.**
  `src/utils/path-matching.ts` exports a single factory
  (`createPathMatcher(patterns)`) that handles mixed string-includes
  and RegExp-test patterns. It's used by `no-test-only-skip` and is
  the right granularity for a shared helper.
- **Sub-slugs in `no-console-log.ts` are encoded with stable IDs.**
  Each pattern in `CONSOLE_PATTERNS` carries its own UUID and slug
  (`console-log`, `console-debug`, `console-info`, `console-warn`,
  `console-error`). This means dashboards can correlate findings to
  specific patterns even though all are reported under the
  `no-console-log` umbrella check.

## Findings

### Three TODO/FIXME detectors overlap

- **Files / code:**
  - `src/checks/no-todo-comments.ts` (slug: `no-todo-comments`,
    `scope.languages = []`, `tags: ['quality', 'documentation']`)
  - `src/checks/quality/code-structure/todo-comments.ts` (slug:
    `todo-comments`, TS only, detects TODO/FIXME/HACK/XXX/OPTIMIZE)
  - `src/checks/quality/code-structure/comment-quality.ts` (slug:
    `comment-quality`, TS only, detects DEBT_MARKER_TODO,
    DEBT_MARKER_FIXME, DEBT_MARKER_HACK, DEBT_MARKER_XXX,
    DEBT_MARKER_OPTIMIZE plus AI metadata + process artifacts;
    `disabled: true` by default — the file header says
    "supersedes quality/no-todos")
- **Pattern / principle:** SRP at the *pack* level — multiple checks
  detecting the same condition produce duplicate findings on the same
  line of code, and the user has to know to disable two of them.
- **Status:** improvement
- **Why it matters:** A user enabling all of `quality` will get up to
  three findings on a single `// TODO` line. The three checks have
  different slugs, different default severities (warning vs warning
  vs error), and different exemption rules — there is no obvious
  precedence. `comment-quality` was clearly intended to replace the
  others (per its file comment) but the older checks weren't removed.
- **Recommendation:** Pick one canonical check and delete the others
  (or reduce them to deprecated aliases that re-export the canonical
  slug). The most defensible split is: keep `no-todo-comments` as the
  cross-language regex scanner (`scope.languages = []`); fold its TS
  variant `quality/todo-comments` into it; promote `comment-quality`'s
  AI-metadata and process-artifact rules into separate slugs
  (`no-ai-attribution`, `no-process-artifacts`) since those are
  genuinely distinct concerns. This both deduplicates and aligns with
  the SRP guideline.

### Three test-modifier detectors overlap

- **Files / code:**
  - `src/checks/testing/no-focused-tests.ts` (slug: `no-focused-tests`
    — only `.only`, `fit`, `fdescribe`)
  - `src/checks/testing/no-skipped-tests.ts` (slug: `no-skipped-tests`
    — only `.skip`, `xit`, `xdescribe`, `xtest`)
  - `src/checks/testing/no-test-only-skip.ts` (slug:
    `no-test-only-skip` — both `.only` and `.skip`, plus
    `concurrent.only/skip`, plus Playwright `test.describe.only/skip`)
- **Pattern / principle:** SRP confused with completeness.
  `no-test-only-skip` is the strict superset, but `no-focused-tests`
  and `no-skipped-tests` weren't retired when it landed.
- **Status:** improvement
- **Why it matters:** Same as the TODO finding — turning all three
  on produces duplicate findings; turning some on requires knowing
  which is canonical.
- **Recommendation:** Resolve the SRP intent first. Either:
  (a) keep `no-test-only-skip` as the canonical check and delete the
  other two — but that's a single fat check covering "only" and
  "skip", which is itself two distinct rules; or (b) keep the
  separated `no-focused-tests` and `no-skipped-tests` (each a clean
  single rule) and delete the umbrella `no-test-only-skip` while
  porting its `concurrent.*` and Playwright variants into the two
  surviving checks. (b) is more SRP-faithful and avoids losing the
  sane separation `.only` (error) vs `.skip` (warning).

### Fat "umbrella" checks bundle multiple sub-rules under one slug

- **Files / code:**
  - `src/checks/quality/no-legacy-code.ts` — single slug
    `no-legacy-code`, but `COMPATIBILITY_PATTERNS` defines 8 sub-rules
    (`deprecated-tag`, `compatibility-layer`, `legacy-code-path`,
    `migration-utility`, `version-check`, `temporary-workaround`,
    `backwards-compat-comment`, `shim-adapter`) with mixed
    severities, each reported under the same slug.
  - `src/checks/quality/code-structure/comment-quality.ts` — single
    slug `comment-quality`, but covers 5 debt markers + AI metadata +
    5 process artifacts = ~11 distinct sub-rules.
  - `src/checks/documentation/directive-audit.ts` — single slug
    `directive-audit`, parses 4 separate directive grammars
    (TypeScript, ESLint, fitness-ignore, semgrep) with 200+ lines of
    grammar-specific code each.
- **Pattern / principle:** SRP at the *check* level — one check, one
  rule. The contrast is `no-console-log`, which uses the same
  internal-PATTERNS shape *but* assigns each pattern its own UUID and
  sub-slug (`console-log`, `console-debug`, etc.) so the granularity
  is preserved through the metadata even though one check runs them.
- **Status:** improvement (deferred — the cost of splitting may
  exceed the benefit for some of these)
- **Why it matters:** A user can't suppress just "shim-adapter" or
  "version-stamp comment artifact" without disabling the whole
  umbrella check. Reports lose the ability to distinguish
  AI-attribution comments from real TODOs in the dashboard. And the
  files themselves grow long enough to attract `file-length-limits`
  ignore directives (which the file already carries).
- **Recommendation:** For each of the three: pick a strategy.
  - `no-legacy-code`: split into ~3 checks: `no-deprecated-tags`,
    `no-compatibility-layer-names`, `no-temporary-workarounds`.
    The version-check, shim-adapter, and backwards-compat-comment
    rules are weak heuristics with high false-positive risk —
    consider just removing them.
  - `comment-quality`: split into `no-todo-comments` (already exists,
    use it!), `no-ai-attribution`, `no-process-artifacts`. Mark
    `comment-quality` deprecated.
  - `directive-audit`: keep as-is but promote the per-source parsers
    (`parseTypeScriptDirectives`, `parseESLintDirectives`,
    `parseFitnessDirectives`, `parseSemgrepDirectives`) to top-level
    helpers, then have four separate checks call them. The file is
    627 lines in part because everything is inlined; splitting would
    not lose functionality.
  - Or, if splitting is rejected, adopt the `no-console-log` model
    everywhere: assign each sub-rule its own UUID and sub-slug, and
    expose them through `CheckViolation.type` so dashboards can group
    by sub-rule. This keeps one Check per file but recovers
    granularity.

### Missing shared "regex-list scanner" template

- **Files / code:** ~13 checks all implement the same shape:
  `src/checks/quality/code-structure/no-console-log.ts`,
  `src/checks/quality/no-window-alert.ts`,
  `src/checks/quality/no-legacy-code.ts`,
  `src/checks/quality/patterns/performance-anti-patterns.ts`,
  `src/checks/quality/code-structure/comment-quality.ts`,
  `src/checks/quality/code-structure/todo-comments.ts`,
  `src/checks/security/no-hardcoded-secrets.ts`,
  `src/checks/security/no-eval.ts`,
  `src/checks/testing/no-test-only-skip.ts`,
  `src/checks/testing/no-skipped-tests.ts`,
  `src/checks/testing/no-focused-tests.ts`,
  `src/checks/architecture/docker-best-practices.ts`,
  `src/checks/architecture/heavy-import-detection.ts`.
- **Pattern / principle:** Template Method / Strategy. Each check
  defines `const PATTERNS = [{ regex, message, suggestion, type? }, …]`,
  then a `for line; for pattern; if match push violation` loop with
  near-identical "skip comment lines / skip test files" pre-filters.
- **Status:** improvement
- **Why it matters:** Behavioral drift. Some checks reset
  `pattern.lastIndex = 0` before `exec` (correct for `/g` regex),
  others don't. Some skip comments via `isCommentLine`, others via
  `trimmed.startsWith('//')`, others via inline regex. Some break
  after first match per line, others report every match. The
  semantics are *almost* the same but not quite, and this is the
  source of subtle FP differences across checks.
- **Recommendation:** Add `defineRegexListCheck` (or
  `defineLineScanner`) to `@opensip-tools/fitness`. Signature would
  accept `patterns: { id?: string; slug?: string; regex: RegExp;
  message: string; suggestion?: string; severity?: Severity }[]`,
  the standard config (id, slug, scope, tags, contentFilter,
  fileTypes), and options for `skipComments`, `skipTestFiles`,
  `firstMatchOnly`. The factory builds the appropriate
  `analyze` closure. ~80% of the 13 sites become 30 lines of
  declaration each; `no-console-log`'s sub-slug pattern can be the
  default. This is a clean Template Method extraction, and it lives
  in `fitness` (not `checks-universal`) because every check pack
  needs it.

### Helper module re-exported through a check barrel

- **Files / code:**
  `src/checks/resilience/config-validation-helpers.ts` (a pure helper
  file: `isDigit`, `isAlphanumericChar`, `skipWhitespace`,
  `parseDigits`).
  `src/checks/resilience/index.ts` line 4:
  `export * from './config-validation-helpers.js'`.
- **Pattern / principle:** Layout / discoverability — helpers should
  be visibly distinct from checks. The `collectCheckObjects` walker
  filters non-Checks via the `isCheck` predicate, so this re-export
  is *functionally* harmless (the helpers don't get registered as
  checks), but it muddles the directory contract: "files under
  `checks/<category>/` are checks."
- **Status:** improvement
- **Why it matters:** A new contributor reading
  `resilience/index.ts` sees 19 re-exports and assumes 19 checks.
  Two of them (`config-validation-helpers`, `sentry/sentry-helpers`
  via `sentry/index.ts`) are not. The `sentry-helpers.ts` case is
  arguably worse: it's filed in `sentry/` and re-exported through
  the sub-barrel, but it's a helper, not a Sentry check.
- **Recommendation:** Either move helpers to `src/check-utils/` or
  `src/checks/_helpers/` and import them by relative path from the
  checks that use them, removing them from the public barrel; or, if
  they're genuinely fitness-wide utilities (`isDigit`,
  `parseDigits`), promote them to `@opensip-tools/fitness/utils`.
  At minimum, delete the `export * from './config-validation-helpers.js'`
  line — the helpers are still imported via the relative path that
  consuming checks already use, and removing the barrel re-export
  preserves the "checks/ contains only checks" invariant.

### Misclassified categories — security checks under `quality/`

- **Files / code:**
  - `src/checks/quality/dependency-security-audit.ts` (tags include
    `security`, `vulnerabilities`)
  - `src/checks/quality/security-scan-suite.ts` (tags include
    `security`, `compliance`; longDescription is entirely about
    dependency vulnerability scanning)
- **Pattern / principle:** Categorization. Six top-level categories
  exist (`architecture`, `documentation`, `quality`, `resilience`,
  `security`, `testing`). The whole point of categories is to give
  users a coarse grouping for `--tags security`, dashboards, etc.
- **Status:** minor — easy to fix, low risk
- **Why it matters:** A user looking at `security/` to understand
  what security checks ship will miss two of the most consequential
  ones. The `security-scan-suite` slug name even suggests it
  belongs in `security/`.
- **Recommendation:** Move both files to `security/` and update the
  barrels (`quality/index.ts`, `security/index.ts`,
  `display/quality.ts`, `display/security-testing.ts`). Slugs do
  not change, so this is purely a layout move with no
  contract-breaking impact.

### Display map is missing entries for four real checks

- **Files / code:** `src/display/index.ts` aggregates entries from
  `architecture.ts`, `quality.ts`, `resilience.ts`, and
  `security-testing.ts`. The check slugs `file-length-limit`,
  `no-todo-comments`, `heavy-import-detection`, and
  `stale-build-artifacts` are not present in any display map; they
  fall back to kebab-to-title-case via `getCheckDisplayNameImpl`.
- **Pattern / principle:** The fallback exists by design, but
  CHECK_DISPLAY entries also encode the icon for dashboard rendering.
  Without an entry, all four checks render with the default
  magnifying-glass icon.
- **Status:** minor
- **Why it matters:** Dashboard quality. Two of these
  (`file-length-limit` and `no-todo-comments`) are root-of-pack
  checks and stand out visually because every other check has a
  themed icon next to it.
- **Recommendation:** Add display entries:
  `'file-length-limit': ['📏', 'File Length Limit']`,
  `'no-todo-comments': ['📝', 'No TODO Comments']`,
  `'heavy-import-detection': ['📦', 'Heavy Import Detection']`,
  `'stale-build-artifacts': ['🏚️', 'Stale Build Artifacts']`.

### Severity strings drift between local and framework conventions

- **Files / code:**
  - `src/checks/quality/no-legacy-code.ts` — `PatternConfig.severity:
    'ERROR' | 'WARNING'` then maps to `'error' | 'warning'` at
    emission time.
  - `src/checks/quality/code-structure/comment-quality.ts` — also
    declares uppercase internally, then emits lowercase.
  - `src/checks/security/semgrep-scan.ts` — receives
    `'ERROR' | 'WARNING' | 'INFO'` from semgrep JSON and maps via
    `mapSeverity`.
- **Pattern / principle:** Single source of truth.
  `CheckViolation.severity` is `'error' | 'warning'` per the
  framework; introducing a parallel uppercase variant inside a
  check's internal types is unnecessary indirection.
- **Status:** minor
- **Why it matters:** Three checks have to remember to lowercase at
  emission. If a future contributor copies the
  `'ERROR' | 'WARNING'` shape but forgets the mapping step, the
  emitted `CheckViolation` will fail framework validation. The
  semgrep case is justified (it's the wire format); the `no-legacy-code`
  and `comment-quality` cases are not.
- **Recommendation:** In `no-legacy-code.ts` and `comment-quality.ts`,
  declare the local severity field as `'error' | 'warning'`
  (lowercase) so the mapping step disappears. Leave `semgrep-scan`
  as is — it's translating an external format.

### `quality/security-scan-suite` and `security/semgrep-scan` and `quality/dependency-security-audit` overlap in intent

- **Files / code:**
  - `quality/security-scan-suite.ts` (slug: `security-scan-suite`,
    runs `pnpm/yarn/npm audit --json`)
  - `quality/dependency-security-audit.ts` (slug:
    `dependency-security-audit`, also runs `pnpm audit --json`,
    `disabled: true` by default)
  - `security/semgrep-scan.ts` (slug: `semgrep-scan`, runs
    `semgrep scan --config auto`)
- **Pattern / principle:** SRP — each check should be a single rule.
  Both `security-scan-suite` and `dependency-security-audit` invoke
  the same package-manager audit command and parse the same JSON
  shape. Their `description` and `longDescription` are nearly
  interchangeable; the only structural difference is that
  `security-scan-suite` autodetects the package manager and
  `dependency-security-audit` is hardcoded to `pnpm` and disabled by
  default.
- **Status:** improvement
- **Why it matters:** Same as the TODO and `.only/.skip` overlaps —
  enabling both produces duplicate findings, and the comment "Suite"
  in `security-scan-suite` implies it bundles multiple tools but the
  current implementation runs only `audit`. The semgrep case is a
  separate tool and should remain its own check.
- **Recommendation:** Pick one. `security-scan-suite` has the better
  package-manager auto-detection; rename it to
  `dependency-vulnerability-audit` and delete the older
  `dependency-security-audit`. Drop "suite" from the name unless and
  until it actually composes multiple tools (e.g. semgrep + audit
  + osv-scanner).

## Non-findings considered and dismissed

- **`PATTERNS` array shape with internal sub-slugs in
  `no-console-log.ts`.** Each entry has a stable UUID and slug
  (`console-log`, `console-debug`, …) so granularity is preserved
  through the violation metadata. This is the right model for
  umbrella checks; it is *not* a hidden second registry, since
  `collectCheckObjects` only walks top-level barrel exports. The
  request prompt flagged this as suspicious; it's actually the
  pattern other umbrella checks should adopt.
- **Sentry sub-pack of 7 checks.** Each is a single rule
  (`sentry-dsn-configured`, `sentry-environment-set`,
  `sentry-pii-scrubbing`, `sentry-release-set`, `sentry-sample-rate`,
  `sentry-source-maps`, `sentry-error-boundary`). They share helpers
  cleanly via `sentry-helpers.ts`. This is the model the rest of the
  pack should follow.
- **`fileLengthLimit` and `noTodoComments` as direct named exports
  alongside the barrel `checks` export.** `src/index.ts` lines 42-43
  re-export them by name; the comment ("Direct exports … for
  convenience / backward compatibility") explains why. They are also
  collected by `collectCheckObjects`, so `seen.add(value.config.id)`
  ensures no double-registration. This is fine.
- **`no-raw-regex-on-code` as a meta-check on the framework.** It
  enforces "regex checks should declare contentFilter" by scanning
  fitness check source files. Uses `scope.languages = ['typescript']`,
  `scope.concerns = ['fitness']` — correct narrow scoping.
- **`fitness-ignore-hygiene` enforcing `@fitness-ignore` directive
  shape.** Requires a `--` reason and a kebab-case slug, flags files
  with > 7 ignore directives. Pure check, no overlap with
  `directive-audit` (which is broader and `disabled: true` by
  default).
- **The 16 barrel `index.ts` files.** This is more than is strictly
  needed (the package could use a single flat `checks/index.ts` that
  imports each check by name) but the nested barrels mirror the
  category directory structure 1:1, which is the intuitive layout
  for a 92-check pack. No change recommended.
- **Use of `process.cwd()` inside
  `dependency-version-consistency.ts`.** The check correctly notes
  it does file-system traversal directly (which the file scoping
  model normally manages); using `process.cwd()` inside an
  `analyzeAll(files)` is a valid escape hatch for "I need to walk
  beyond the cached file list to find every package.json." The
  ignore directive
  `@fitness-ignore-file fitness-check-standards` documents the
  decision. Not ideal but justified for monorepo-wide scans.
- **Per-pattern UUIDs in `CONSOLE_PATTERNS`.** The same UUID
  governance question applies as in `checks-typescript`'s test
  fixtures — these IDs aren't in the canonical check registry, but
  they're stable identifiers for sub-rules within an umbrella check.
  Acceptable as long as collisions are managed.
