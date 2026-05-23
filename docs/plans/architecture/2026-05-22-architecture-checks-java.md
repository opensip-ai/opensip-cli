---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-java"
package: "@opensip-tools/checks-java"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-java

## Summary

`@opensip-tools/checks-java` is a single-check pack (`java-no-print-stack-trace`).
The pack-shape — `src/index.ts` barrel + `src/checks/<slug>.ts` + `src/__tests__/`
trio (`analyze` / `<check-name>` / `run`) — exactly mirrors the other
single-language sibling packs (`checks-go`, `checks-python`, `checks-cpp`).
The `defineCheck` invocation is idiomatic and consistent with the cohort: pure
`analyze` function exported separately for unit testing, regex-driven detection
guarded by the `strip-strings-and-comments` content filter, identifier-shaped
UUIDv4 `id`, slug-prefixed-by-language naming, and tags drawn from the same
quality/observability vocabulary used by the Go pack.

The pack is small but justified: Java is a first-class language in the bundled
adapter set (`@opensip-tools/lang-java` is registered in the CLI bootstrap at
`packages/cli/src/index.ts:71`), and a single-check pack is the minimum
publishable unit for keeping language-specific check logic outside
`checks-universal`. Adding a new Java check is an additive edit — same pattern
already exists in `src/checks/`.

Two real findings stand out: (1) `package.json` declares
`@opensip-tools/lang-java` as a runtime `dependency` even though only one test
file imports it, and via a discouraged subpath (`/strip`) at that, and (2) the
sibling cohort matches the framework's content-filter behaviour by carefully
chosen test inputs rather than by re-running the strip pipeline in tests — the
Java pack is the lone outlier here. Beyond those, the pack is in good shape.

## Existing patterns (correct usage)

- **Pure-analyzer split.** `analyzePrintStackTrace(content)` is exported
  separately from `noPrintStackTrace` (the `defineCheck(...)` result), with a
  doc comment explaining why (`defineCheck` wraps `analyze` into an `execute`
  closure that needs an `ExecutionContext`). This is the same idiom used by
  `checks-go` (`analyzeFmtPrint`) and `checks-python` (`analyzeBareExcept`).
  Files: `src/checks/no-printstacktrace.ts:24`.

- **Idiomatic `defineCheck` usage.** Stable UUIDv4 `id`, language-prefixed
  `slug` (`java-no-print-stack-trace`), `scope: { languages: ['java'],
  concerns: [] }`, tags `['quality', 'observability', 'java']` — every field
  matches the shape `defineCheck` expects (see
  `packages/fitness/engine/src/framework/define-check.ts:218`). The
  `contentFilter: 'strip-strings-and-comments'` is the right choice for a
  regex check on a Java-style language with `//` and `/* */` comments.
  Files: `src/checks/no-printstacktrace.ts:44-55`.

- **Regex hygiene.** `PRINT_STACK_TRACE_PATTERN` is a module-scoped global
  regex and `.lastIndex = 0` is reset before each `exec` in the loop —
  necessary because `/g` regexes carry state across calls. Same pattern as
  `checks-go`. Files: `src/checks/no-printstacktrace.ts:16,29`.

- **Imports stay inside the layer.** Production code imports only
  `@opensip-tools/fitness` (`defineCheck`, `CheckViolation`). No reach into
  `@opensip-tools/cli`, `@opensip-tools/contracts`, or `@opensip-tools/core`
  — consistent with the `check-pack-no-cli` and the broader
  layering rules in `.dependency-cruiser.cjs`.

- **Barrel + plugin contract.** `src/index.ts` exports `checks`, `metadata`,
  and a named re-export of the check, matching the `FitPluginExports`
  contract in `packages/fitness/engine/src/plugins/types.ts`. The CLI's
  plugin discovery picks the pack up by package-name pattern.

- **Test trio matches the cohort.** `src/__tests__/{analyze,no-printstacktrace,run}.test.ts`
  is the same three-file pattern present in the Go and Python packs:
  pure-analyzer coverage, focused fixtures around the content filter
  semantics, and an end-to-end `noPrintStackTrace.run(cwd, ...)` that
  exercises the `defineCheck`-wrapped closures.

## Findings

### 1. `@opensip-tools/lang-java` is a runtime dependency but is consumed only by tests, via a subpath

- **Files / code:**
  - `packages/fitness/checks-java/package.json:30` —
    `"@opensip-tools/lang-java": "workspace:*"` is in `dependencies`, not
    `devDependencies`.
  - `packages/fitness/checks-java/src/__tests__/no-printstacktrace.test.ts:1`
    — `import { stripComments, stripStrings } from '@opensip-tools/lang-java/strip'`
    is the sole import-site. No production file under `src/checks/` or
    `src/index.ts` imports `lang-java` (`grep -rn "lang-java" src` returns
    only this one test).

- **Pattern / principle:** Workspace import rules in `CLAUDE.md` say "Subpath
  exports are strongly discouraged; prefer the package barrel." The same
  rules also distinguish runtime `dependencies` (which travel with the
  published artifact) from `devDependencies` (test-only / build-only).
  Sibling packs `checks-go`, `checks-python`, and `checks-cpp` declare only
  `@opensip-tools/fitness` as a runtime dependency.

- **Status:** Active. Both items are observable today.

- **Why it matters:**
  - Consumers of the published `@opensip-tools/checks-java` install
    `@opensip-tools/lang-java` transitively even though the production check
    never imports it — the bundled CLI supplies the Java adapter via
    `defaultLanguageRegistry.register(javaAdapter)` at
    `packages/cli/src/index.ts:71`, and the framework's `applyContentFilter`
    looks the adapter up by file extension (`packages/fitness/engine/src/framework/define-check.ts:108`).
    The dependency adds install footprint without runtime value.
  - The `/strip` subpath import bypasses the package barrel. If
    `@opensip-tools/lang-java` ever drops or renames the `./strip` export
    in `package.json` (currently at
    `packages/languages/lang-java/package.json:22`), this test will silently
    break the build for this pack alone.

- **Recommendation:** Move `@opensip-tools/lang-java` from `dependencies` to
  `devDependencies` to match the cohort. Ideally also remove the test-side
  reach into `lang-java/strip` by either (a) emulating the strip behavior
  inline in the test (the Go pack covers the same surface by choosing test
  inputs that don't contain quoted/commented matches — see
  `packages/fitness/checks-go/src/__tests__/no-fmt-print.test.ts`), or (b)
  driving the test through the public framework path
  (`noPrintStackTrace.run(cwd, ...)`) the way `run.test.ts` already does, so
  the framework's `applyContentFilter` is what gets exercised end-to-end.
  Either route eliminates the dependency entirely.

### 2. Test-side dependency on the matching `lang-*` pack diverges from sibling convention

- **Files / code:**
  - `packages/fitness/checks-java/src/__tests__/no-printstacktrace.test.ts:1`
    imports `stripComments`, `stripStrings` from `@opensip-tools/lang-java/strip`
    to simulate the framework's content-filter inside the unit test.
  - Sibling packs do not: `packages/fitness/checks-go/src/__tests__/no-fmt-print.test.ts`,
    `packages/fitness/checks-python/src/__tests__/analyze.test.ts`,
    `packages/fitness/checks-cpp/src/__tests__/clang-tidy.test.ts` — none
    import their respective `@opensip-tools/lang-*` package.

- **Pattern / principle:** Sibling cohort consistency. The pure-analyzer
  tests across the cohort treat the framework's content-filter as out-of-scope,
  cover their false-positive edge cases via inputs that don't contain quoted
  or commented matches, and rely on `run.test.ts` to validate end-to-end
  filter behaviour through the real framework path.

- **Status:** Active. The Java pack has two redundant test files
  (`analyze.test.ts` and `no-printstacktrace.test.ts`) covering largely the
  same surface; only the second one reaches into `lang-java/strip`.

- **Why it matters:** Subjectively, the Java approach is arguably *more*
  faithful to what the framework does — but it couples the test to a
  specific public subpath of a peer package and creates a maintenance burden
  the cohort doesn't share. If the framework's content-filter dispatch
  changes (`packages/core/src/languages/content-filter-dispatch.ts`), the
  cohort updates uniformly through `run.test.ts`; the Java pack would also
  need its hand-rolled simulation kept in sync.

- **Recommendation:** Align with the cohort. Replace the
  `lang-java/strip` calls in `no-printstacktrace.test.ts` with either
  comment-free / string-free inputs (Go pack approach) or assertions driven
  via `noPrintStackTrace.run(cwd, ...)` against fixture files containing
  comment/string false-positives (extends the existing `run.test.ts`
  pattern). Combined with finding 1, this lets the package drop
  `@opensip-tools/lang-java` from its dependencies entirely.

### 3. `metadata.version` in the barrel is hard-coded and stale

- **Files / code:** `packages/fitness/checks-java/src/index.ts:8` declares
  `version: '0.6.1'` while `package.json:3` is at `1.3.1`.

- **Pattern / principle:** Single source of truth for version data. The
  `metadata` field on `FitPluginExports` is part of the plugin contract
  (`packages/fitness/engine/src/plugins/types.ts:18`), surfaced to consumers
  of the plugin. Hard-coded version strings in source go stale every release.

- **Status:** Pack-wide pattern, not Java-specific — `checks-go`,
  `checks-python`, and `checks-cpp` all encode `version: '0.6.1'` in their
  barrels too. Flagged here because it appears in the audited file; the fix
  ought to be coordinated across the cohort, not done in isolation in
  checks-java.

- **Why it matters:** Anyone consuming `metadata.version` programmatically
  (UI, plugin debug output, dashboard catalog entries, telemetry) gets a
  three-versions-old number. Today there's no obvious consumer reading
  `metadata.version` (`grep` shows only producer side), so the impact is
  latent — but the moment a consumer is added, this is a silent bug.

- **Recommendation:** Either (a) drop the `version` field from `metadata`
  across the cohort and read `package.json` at load time inside the
  fitness plugin loader, or (b) generate the field at build time. Don't
  fix only checks-java; the divergence would be a worse outcome than the
  status quo.

## Non-findings considered and dismissed

- **"Pack ships only one check — fold it into checks-universal."** Dismissed.
  `checks-universal` covers concerns that are language-agnostic (Docker,
  `.env`, Sentry, generic structure). A Java-specific regex with the
  language scope `['java']` is exactly the kind of content that belongs in
  `checks-java`. The single-check footprint is consistent with the cohort
  (Go, Python, C++ each ship one check).

- **No `display/` subdirectory.** Dismissed. The `display/` folder is only
  present in the larger packs (`checks-typescript`, `checks-universal`).
  The kebab-to-title-case fallback in the engine handles single-check
  packs without one. The cohort does not have a `display/` subdirectory.

- **Direct `@opensip-tools/lang-java` import in production source.**
  Dismissed — the production code (`src/checks/no-printstacktrace.ts`)
  imports only `@opensip-tools/fitness`. The lang-java edge is test-only
  (covered above in finding 1).

- **`scope.concerns: []` is empty.** Dismissed. Sibling packs
  (`no-fmt-print`, `no-bare-except`) also use `concerns: []` for
  language-only filtering. The framework's resolution rules
  (`checkOverrides > scope matching > file cache fallback`, per CLAUDE.md
  on file scoping) handle empty `concerns` correctly — the language scope
  alone is sufficient to target Java files.

- **Regex `/\.printStackTrace\s*\(\s*\)/g` could miss `printStackTrace`
  on a same-line cast.** Dismissed — out of scope for an architecture
  audit; this is a detection-quality concern. The existing test
  `flags calls with whitespace inside the parens` shows the regex
  intentionally allows internal whitespace.

- **Layering exception against `lang-no-fitness-except-typescript`.**
  Dismissed. That dependency-cruiser rule applies to imports from `lang-*`
  pointing at `@opensip-tools/fitness`. The Java pack imports the other
  way around — and only in tests, which dependency-cruiser excludes
  (`exclude.path: ['/__tests__/', '\\.test\\.(ts|tsx)$']`). No layering rule
  is being tripped.
