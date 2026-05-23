---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/lang-typescript"
package: "@opensip-tools/lang-typescript"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-lang-typescript.md
---
# Architecture audit (delta) — @opensip-tools/lang-typescript

## Summary

Wave 4 inverted the most consequential layering smell in this package:
`filterContent` / `clearFilterCache` / `FilteredContent` now live at
`src/filter.ts` (288 lines) inside `lang-typescript`, the
`@opensip-tools/fitness` import in `src/strip.ts` is gone, the
`lang-no-fitness-except-typescript` dep-cruiser exception was deleted, and
a hard `lang-no-fitness` rule replaced it. The seven function-scope AST
helpers were promoted to `ast-utilities.ts`. The package now has zero
imports from `@opensip-tools/fitness` (verified with grep).

The package's contract surface (`typescriptAdapter`) is still the right
shape and the test suite has grown to three files (`adapter.test.ts`,
`filter.test.ts`, `ast-utilities.test.ts`). The DIP and layering posture
is now clean: only `@opensip-tools/core` (via the package barrel and the
sanctioned `parse-cache.js` subpath) and `typescript` are imported.

What didn't move with Wave 4: the `ast-utilities.ts` shim is now BIGGER
(370 lines vs. 200 prior), the duplicate `parseSource` (TSX-blind) is
still there (`ast-utilities.ts:25`), the four direct callers of the
public `parseSource` still bypass the cache, the `query` API still has
zero production consumers, and the five subpath exports in
`package.json` still ship a fragmented API. The `ts` namespace is still
re-exported only from `./ast-utilities`, not from the top-level barrel —
so prior Finding 7's recommended migration step is half done (fitness
side cleaned up, lang-typescript side not promoted).

The C-family lexer scaffolding the brief mentions was extracted into
`@opensip-tools/core/languages/strip-utils.ts` (lines 51–370) for the
benefit of OTHER lang packs; `lang-typescript`'s `filter.ts` does not
yet use it (`buildLineStarts` is still privately defined at
`filter.ts:52`). That's a Group B / Phase B1 concern that has not
landed for this pack.

Net delta: 1 prior finding closed, 1 partially closed, 5 remain open
unchanged, 4 net-new findings (3 new from Wave 4 surface area, 1 missed).

## Status of prior findings (2026-05-22)

| F# | Title (abbrev) | Prior status | Today |
|----|----------------|--------------|-------|
| 1 | `ast-utilities.ts` is a 200-line shim | Open | **OPEN — REGRESSED.** Now 370 lines (+170, +85%). The seven Phase D2 helpers were ADDED to the same shim instead of being placed in concern-named modules; no @deprecated markers exist; no decision-log entry. The fitness shadow file (`framework/ast-utilities.ts`) shrank to 42 lines but still duplicates `isPropertyAccess` and exposes `getASTLineNumber` as a one-name-different twin of `getLineNumber` — its own docstring (lines 22–23) admits "kept here because the duplication hasn't been flagged for migration yet." |
| 2 | `parseSource` duplicated, TSX-divergent | Open | **OPEN.** `ast-utilities.ts:25–31` still defines `parseSource` without `ts.ScriptKind.TSX`; `parse.ts:10–22` defines the TSX-aware version. Barrel re-exports the TSX-aware one; the `./ast-utilities` subpath still serves the non-TSX one. `ast-utilities.test.ts:24,29` STILL imports `parseSource` from `./ast-utilities.js` so the duplicate's test coverage masks the issue. |
| 3 | Public `parseSource` bypasses parse cache | Open | **OPEN.** All four call sites still re-parse per check: `pii-exposure-in-logs.ts:182`, `sql-injection.ts:318`, `input-sanitization.ts:237`, `unsafe-secret-comparison.ts:91`. No `@deprecated` JSDoc on `parse.ts`'s export. |
| 4 | `query` API has no consumers | Open | **OPEN.** `query.ts` is unchanged (76 lines). Still only consumed by `adapter.test.ts`. No other lang pack implements it. The private `walk` (lines 11–14) still duplicates `walkNodes` (`ast-utilities.ts:48–54`). |
| 5 | `filterContent` in wrong package, fitness back-edge | Open | **CLOSED.** `filter.ts` now hosts `filterContent`/`clearFilterCache`/`FilteredContent`. `strip.ts` imports from `./filter.js` (`strip.ts:9`). `lang-no-fitness-except-typescript` rule deleted; replaced by hard `lang-no-fitness` rule (`.dependency-cruiser.cjs:235–243`). `fitness/engine/src/framework/content-filter.ts` was deleted (verified with `ls`). |
| 6 | Five subpath exports with no consumers | Open | **OPEN.** `package.json:18–25` still publishes `./adapter`, `./parse`, `./query`, `./strip`, `./ast-utilities`. Workspace grep finds zero external consumers (graph imports only the barrel). The `./ast-utilities` subpath in particular still leaks the duplicate `parseSource`. |
| 7 | `ts` namespace duplicated re-export | Open | **PARTIALLY CLOSED.** `fitness/engine/src/index.ts:40–45` deleted its `ts` re-export with a clear migration comment. But `lang-typescript/src/index.ts` still does NOT export `ts` at the top level — it's only re-exported via `./ast-utilities` (`index.ts:34`). Plan D3 step 3 ("add `export * as ts from 'typescript'` at the top of `lang-typescript/src/index.ts`") was not executed. The barrel surface is still mediated through the legacy shim. |
| 8 | `adapters` plugin contract — informational | Settled | **SETTLED.** `adapter.ts:21` unchanged. |

## Net-new findings

### F-N1 / P1 / `src/ast-utilities.ts` lines 240–367 — Wave 4 added 130 lines of function-scope helpers to a known-deprecated shim

- **What (SOLID/GoF):** SRP — the file's stated purpose ("re-exported so
  existing TS checks can keep their imports pointing at
  @opensip-tools/lang-typescript") was migration-shim. Promoting seven
  more helpers into it without splitting first compounds the prior
  Finding 1 instead of resolving it. The six new sections
  (`FunctionLikeNode` type, `isFunctionLike` predicate,
  `findEnclosingFunction`, `findEnclosingFunctionBody`,
  `getEnclosingFunctionName`, `findEnclosingScope`, `isAsync`,
  `isInAsyncContext`, `isInsideConditionalBlock`) are *eight distinct
  concerns*: function detection, function-name extraction, scope walking,
  async detection, async-context propagation, conditional-context
  detection — each well-formed in isolation, none belonging in the same
  module as `parseSource` and `countUnescapedBackticks`.
- **Why it matters:** The file now triggers `@fitness-ignore-file
  batch-operation-limits` (line 1) AND would trigger `file-length-limits`
  if it didn't already exempt itself elsewhere — see `filter.ts:1` for
  the same pattern. A check author looking up `findEnclosingFunction`
  ends up scrolling past comment-detection, source-parsing, and string-
  utility code that has no semantic relationship to scope analysis. The
  file is now too big to skim, and the contract author's reflex when
  adding the next helper will be to follow precedent and pile on.
- **Recommendation:**
  1. Split `ast-utilities.ts` along seven concern boundaries NOW, before
     the next round of helpers lands. Suggested:
     `src/parse.ts` (already exists; absorb `getSharedSourceFile`),
     `src/walk.ts` (`walkNodes`),
     `src/inspect.ts` (`getIdentifierName`, `getPropertyChain`,
     `getLineNumber`, `getColumn`, `isPropertyAccess`, `isLiteral`,
     `isInStringLiteral`),
     `src/finders.ts` (`findCallExpressions`, `findBinaryExpressions`,
     `findTemplateLiterals`),
     `src/comments.ts` (`isInComment`),
     `src/strings.ts` (`countUnescapedBackticks`),
     `src/scope.ts` (the seven Phase D2 helpers + `FunctionLikeNode`).
  2. Keep `ast-utilities.ts` as a barrel re-exporting from those modules
     for one release; mark each re-export `@deprecated` with the new
     concern-named import target. Then delete the shim in v2.
  3. While splitting, fold the duplicate `parseSource` (Finding 2) into
     `parse.ts` to retire it.

### F-N2 / P2 / `src/index.ts:34` — `ts` namespace still routed through `./ast-utilities`; Plan D3 step 3 not executed

- **What (SOLID/GoF):** ISP / single source of truth. Plan D3 explicitly
  prescribed `export * as ts from 'typescript'` (or equivalent) at the
  top of `lang-typescript/src/index.ts`. The fitness side of D3 ran
  (`fitness/engine/src/index.ts:40–45` removed the re-export), but the
  lang-typescript side stops at `export { ts } from './ast-utilities.js'`
  (`index.ts:34`) — the `ts` namespace is still gated on the legacy
  shim's existence.
- **Why it matters:** When Finding 1 splits `ast-utilities.ts`, the `ts`
  re-export must move alongside, but moving it from the shim is a
  user-visible barrel restructuring; if the top-level export had been
  added in Wave 4 (as planned), the shim split would be transparent for
  `ts` consumers. The two-step migration is now a one-step one. Also,
  consumers reading `index.ts` see `ts` wedged inside a comment block
  marked "Legacy AST helpers" (lines 9–35) — it doesn't read like a
  first-class export.
- **Recommendation:** Promote `ts` to a top-level export in `index.ts`
  (above the legacy block, e.g. `export { default as ts } from
  'typescript'` — preferred — or `import * as ts from 'typescript';
  export { ts }` if `export {} from 'typescript'` keeps tripping on the
  `export = ` semantics noted at `ast-utilities.ts:369`). Remove the `ts`
  re-export from the legacy block once the top-level export is in.

### F-N3 / P2 / `src/filter.ts:52–59`, `src/filter.ts:65–82` — `buildLineStarts` and `linesToSet` reinvent core's `strip-utils` primitives

- **What (SOLID/GoF):** DRY / DIP. Wave 4 moved `filterContent` here but
  did not adopt `@opensip-tools/core/languages/strip-utils.ts:360–370`'s
  `buildLineStarts` — `filter.ts:52–59` defines its own copy. The
  `linesToSet` and `isInRegions` helpers (lines 65–108) likewise solve
  the same line-resolution problem as core's primitives but with a
  different implementation signature. Group B / Phase B1 was scoped to
  the C-family adapters (lang-java, lang-go, lang-cpp, lang-rust) but
  the rationale ("language-agnostic glue, every adapter likely needs
  these") applies equally here.
- **Why it matters:** The package shipped Wave 4 with the cycle
  inversion BUT not with the upgrade to core's shared primitives. As
  long as `buildLineStarts` is duplicated, future fixes (UTF-16
  surrogate-pair handling, BOM stripping, CRLF edge cases) have to land
  in two places. Core's `buildLineStarts` already has the documented
  comment about UTF-16 unit indexing that this copy is missing.
- **Recommendation:** Replace the local `buildLineStarts` (`filter.ts:52`)
  with an import from `@opensip-tools/core/languages/strip-utils.js`
  (subpath import is already sanctioned by CLAUDE.md alongside
  `parse-cache.js`; alternatively re-export through the core barrel
  first). Then audit `linesToSet` / `isInRegions` for whether core
  should grow a `regionToLines(content, regions)` primitive; if yes,
  extract; if no, leave as TS-specific.

### F-N4 / P3 / `src/__tests__/ast-utilities.test.ts:24,29` — tests still pin the duplicate `parseSource`

- **What (SOLID/GoF):** Test-as-contract. The tests import
  `parseSource` from `../ast-utilities.js` (line 24), not from
  `../parse.js`. So they validate the TSX-blind copy. As long as those
  tests pass, deleting the duplicate (Finding 2's recommendation) is a
  visible test-file edit, which raises the apparent cost of the cleanup
  and discourages it.
- **Why it matters:** This is the load-bearing reason Finding 2 hasn't
  closed. A test re-pointing PR ("`import { parseSource } from
  '../parse.js'`") is one line of mechanical change but nobody has
  filed it — so the duplicate persists.
- **Recommendation:** Re-point the test imports to `../parse.js`
  (eight test imports total: `parseSource` plus the seven helpers
  promoted in Phase D2 — the helpers should remain on
  `ast-utilities.js` until split). Then delete the local `parseSource`
  in `ast-utilities.ts` (lines 25–31) so the duplicate is gone.

## Findings the prior audit missed (caught today)

### F-M1 / P3 / `src/filter.ts:159–185` — `filterContent` swallows ALL exceptions and silently degrades to raw content

- **What (SOLID/GoF):** Liskov / observable behavior. The `try { return
  filterContentImpl(content) } catch { … log.debug … fallback }` block
  (lines 166–184) traps every error from the TS scanner. The fallback
  returns raw content, raw `codeNoComments`, an empty `commentLines`
  set, and stub `isInString` / `isInComment` predicates that always
  return false. Every downstream check that relied on the FilteredContent
  to mask strings or detect comments will now operate on un-stripped
  source — silently producing false positives or false negatives.
- **Why it matters:** The TS scanner is robust but not infallible
  (resource exhaustion, unsupported character class). When it fails the
  callers get back a structurally valid `FilteredContent` whose
  semantics have flipped — and the only signal is a `logger.debug`
  message that is off by default. Compare with `parseSource`, which
  returns `null` on failure and forces callers to handle the absence;
  the contract here is much weaker.
- **Recommendation:** Either (a) widen `FilteredContent` with a
  `degraded: boolean` flag and have callers branch on it, or (b)
  surface a counter via `logger.warn` (not `debug`) when the catch
  fires, so degraded runs are visible at default log level. Option (a)
  is the SOLID answer; option (b) is the cheap mitigation.

### F-M2 / P3 / `src/filter.ts:138–148` — module-level mutable cache state in a "lang adapter"

- **What (SOLID/GoF):** SRP — a language adapter ought to be a pure
  contract object plus pure functions. The `filterCache` Map and the
  `filterCacheIdleTimer` (lines 138–148) make `filter.ts` stateful at
  module load. That's already true of `core/languages/parse-cache.ts`,
  but parse-cache is hosted in the kernel and treated as a registry-
  style singleton. Putting equivalent module-level state in a lang pack
  means two stateful subsystems whose lifecycles are not coordinated
  (parse-cache has its own idle timer, filter-cache has another, neither
  knows about the other).
- **Why it matters:** When tests spin up multiple fitness runs in the
  same process, each run wants a clean cache. Today they call
  `clearFilterCache()` explicitly (six times in `filter.test.ts`),
  which works, but the integration with parse-cache is invisible.
  An embedder using both is responsible for clearing two caches with
  two different APIs.
- **Recommendation:** Move the cache mechanism into a small
  `core/languages/cache.ts` registry (a `CacheRegistry` that holds
  named per-adapter caches and clears them all on `clearAll()`). Have
  both parse-cache and filter-cache register through it. Defer if the
  fitness-side cache audit is already pending — flag this as an
  alignment opportunity.

## Overall assessment

Wave 4's cycle break is the right call and was executed cleanly: the
DIP / layering smell that anchored the prior audit is gone, the
dep-cruiser rule is now a hard barrier, and the back-edge that would
have required a follow-up to re-discover doesn't exist. Findings 5 and
the fitness side of 7 are permanently closed.

What didn't go well: Wave 4's Phase D2 helpers landed in
`ast-utilities.ts` directly, growing the file from 200 to 370 lines and
locking in the shim shape rather than chipping at it. Plan D3 step 3
(top-level `ts` export) was forgotten. Filter.ts was lifted in place
without adopting core's `buildLineStarts`, leaving a piece of
language-agnostic glue duplicated. The four `parseSource` cache-bypass
sites and the duplicate `parseSource` in the shim are unchanged.

Severity-ranked recommendations for the next pass:

- **P1:** Split `ast-utilities.ts` along its seven concerns (F-N1 +
  prior F1). This unblocks the shim retirement and removes the precedent
  of "drop new helpers into the shim."
- **P2:** Promote `ts` to a top-level export in `index.ts` (F-N2 +
  prior F7 closure). One-line edit.
- **P2:** Adopt core's `buildLineStarts` from `strip-utils.ts` (F-N3).
  One-line edit + delete five lines.
- **P3:** Re-point `ast-utilities.test.ts` imports to `parse.ts` and
  delete the duplicate `parseSource` (F-N4 + prior F2). Mechanical.
- **P3:** Decide on the `query` API (prior F4) and the five subpath
  exports (prior F6) before v2 — both become breaking changes once
  another major ships with them.
- **P3:** Either widen `FilteredContent` with a `degraded` flag or move
  the catch's log to `warn` (F-M1).

The package's contract surface (`typescriptAdapter`, `LanguageAdapter
<ts.SourceFile, ts.Node>`) and Strategy/Adapter shape remain correct.
Layering is now clean. The remaining work is a tidiness and surface-
area exercise, not a structural one.
