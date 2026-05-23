---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-typescript"
package: "@opensip-tools/lang-typescript"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-typescript

## Summary

`@opensip-tools/lang-typescript` is the most capable language adapter in the
workspace and the only one that wires up the optional `LanguageQueryAPI`. It
implements the `LanguageAdapter<ts.SourceFile, ts.Node>` contract from
`@opensip-tools/core` and is consumed by 55+ files across `checks-typescript`,
`graph/engine`, and the CLI bootstrap.

The package's contract surface (the `typescriptAdapter` object) is clean and
correctly typed — `TTree`/`TNode` are explicitly bound to `ts.SourceFile`/
`ts.Node` per the contract, which is the right shape for adapter pattern (the
tree types are opaque to core, concrete to the adapter). What lets the package
down is everything around that core: a 200-line `ast-utilities.ts` of legacy
helpers re-exported through the barrel, a duplicated `parseSource`
implementation that disagrees with itself on `ScriptKind`, a `query` API with
no production consumers, and a public surface that's fragmented across five
subpath exports nobody is using.

The documented `lang-no-fitness-except-typescript` exception is real and
should be paid down — `filterContent` belongs in core (or in lang-typescript
itself), not behind a back-edge to `@opensip-tools/fitness`. Once that
inversion is fixed the exception in `.dependency-cruiser.cjs` can be removed.

The `ast-utilities.ts` shim is the single biggest lever: it carries 30+ check
files' worth of imports, contains a buggy `parseSource` shadow, and exists
purely to keep old import paths working. A short migration window
(replace barrel import-list with `getSharedSourceFile` / `parseSource` from
`./parse`) lets the helper duplication shrink and lets `parseSource` pick up
TSX support.

The package builds, tests pass (~10 cases between `adapter.test.ts` and
`ast-utilities.test.ts`), and dependency-cruiser is green. The findings below
are about consolidating the public surface, not about fixing breakage.

## Existing patterns (correct usage)

- **Adapter object shape (`adapter.ts`)** — `typescriptAdapter` is a single
  constant that satisfies the `LanguageAdapter<ts.SourceFile, ts.Node>`
  interface. The `query` field is conditional via the optional contract slot.
  The `adapters` array export matches the plugin contract used by all other
  lang packs (rust, python, java, go, cpp).
- **Type-parametric contract** — exposing `LanguageAdapter<ts.SourceFile,
  ts.Node>` is correct adapter-pattern type design. Core stays opaque on
  `TTree`/`TNode`; the lang pack supplies the concrete types. Callers that
  know they have the TS adapter get full TS types back; cross-language
  callers see `unknown` and can't accidentally couple.
- **Cache layering for the parse cache** — `getSharedSourceFile` defers to
  `getParseTree(typescriptAdapter, …)` from core, which means the cache is
  language-agnostic and the adapter is the single source of truth for
  parsing. This is the right inversion: core hosts the cache, the adapter
  provides the parse function.
- **`stripStrings`/`stripComments` length preservation** — the adapter's
  contract is "preserve byte length so positions stay stable." Both
  implementations satisfy that, and the test in `adapter.test.ts` asserts
  it explicitly. Other lang packs (rust, cpp) follow the same contract.
- **dep-cruiser exception is fenced** — `lang-no-fitness-except-typescript`
  in `.dependency-cruiser.cjs` is narrowly scoped (only matches
  `lang-typescript/`), so the exception can't quietly grow into other lang
  packs without the rule firing.

## Findings

### `ast-utilities.ts` is a 200-line legacy shim that should be split or absorbed

- **Files / code:** `packages/languages/lang-typescript/src/ast-utilities.ts`,
  `src/index.ts` lines 8–26 (re-exports the 14 helpers + `ts` namespace)
- **Pattern / principle:** Single Responsibility, ISP, anti-corruption
  layer should have a sunset plan.
- **Status:** **Open — accumulating, not stable.** The file's docstring says
  "re-exported so existing TS checks can keep their imports pointing at
  @opensip-tools/lang-typescript instead of @opensip-tools/core/framework/*",
  which is a migration shim. There is no migration plan, no deprecation
  marker, and no decision log entry pointing at when this collapses. The
  fitness engine still keeps a parallel copy of `getLineNumber` and
  `isPropertyAccess` in `framework/ast-utilities.ts` — that file's docstring
  flags the duplication ("kept here because the duplication hasn't been
  flagged for migration yet"). So both sides of the boundary are sitting
  in a half-migrated state.
- **Why it matters:** The file mixes seven concerns into one module:
  source parsing (`parseSource`, `getSharedSourceFile`), tree walking
  (`walkNodes`), node inspection (`getIdentifierName`, `getPropertyChain`,
  `getLineNumber`, `getColumn`, `isPropertyAccess`, `isLiteral`,
  `isInStringLiteral`), node finders (`findCallExpressions`,
  `findBinaryExpressions`, `findTemplateLiterals`), comment detection
  (`isInComment`), string utilities (`countUnescapedBackticks`), and a
  re-export of the entire `ts` namespace. The `@fitness-ignore-file
  batch-operation-limits` directive at the top is a tell: the file's own
  size triggers a check. SRP-wise this is a mini-package, not a module.
- **Recommendation:**
  1. Add a `@deprecated` JSDoc to each `ast-utilities` helper directing
     callers to its real home (e.g. `@deprecated import from '@opensip-tools/lang-typescript/<concern>' instead`)
     and a deprecation date target.
  2. Split the file along the seven concerns above, keeping `ast-utilities.ts`
     as a barrel that re-exports them. This makes the surface inspectable and
     lets later steps remove individual concerns.
  3. Land a follow-up that walks the 50+ `getSharedSourceFile` import sites
     in `checks-typescript` and points them at a stable concern-named entry
     point (`./parse` for parsing, `./node-walk` for walking, etc).
  4. Once callers have migrated, delete `ast-utilities.ts` and the parallel
     `framework/ast-utilities.ts` in fitness.

### `parseSource` is duplicated with divergent behavior — TSX support is silently inconsistent

- **Files / code:**
  - `src/parse.ts` line 12: `ts.createSourceFile(…, ts.ScriptKind.TSX)`
  - `src/ast-utilities.ts` line 27: `ts.createSourceFile(…)` (no ScriptKind)
- **Pattern / principle:** DRY, single source of truth, no "two functions
  with the same name."
- **Status:** **Open — latent correctness bug.** The barrel re-exports
  `parseSource` from `./parse.js` (TSX-aware) but `ast-utilities.ts`
  defines its own `parseSource` that does NOT pass `ScriptKind.TSX`. The
  two are reachable: the barrel's named export wins for `import { parseSource }
  from '@opensip-tools/lang-typescript'`, but anyone importing through the
  `./ast-utilities` subpath (or copying the legacy ast-utilities source as a
  reference) gets the non-TSX version. Today nothing imports the subpath, so
  this is dormant. But the docstrings on both functions are identical
  ("Parse TypeScript/JavaScript source into a SourceFile. Returns null on
  parse failure") which means the divergence is undocumented.
- **Why it matters:** TSX vs TS parsing changes how `<Foo>` is interpreted
  (JSX vs type assertion). A check that uses the non-TSX path on a `.tsx`
  file gets a different AST than a check using the TSX path on the same
  file. That violates the principle that parsing the same file should
  produce the same tree across the package's surface.
- **Recommendation:** Delete `ast-utilities.ts`'s `parseSource` and have
  the barrel-style `ast-utilities` re-export `parseSource` from `./parse.js`.
  If any caller relies on the non-TSX path it should be made explicit.
  The `ast-utilities.test.ts` tests the local `parseSource` — those tests
  should switch to importing from `./parse.js` (or from the barrel) so the
  duplicate vanishes.

### `parseSource` (the public one) bypasses the parse cache; four checks pay the cost

- **Files / code:** `src/parse.ts` (no cache); 4 checks call
  `parseSource(content, filePath)` directly:
  - `fitness/checks-typescript/src/checks/quality/observability/pii-exposure-in-logs.ts:181`
  - `fitness/checks-typescript/src/checks/security/unsafe-secret-comparison.ts:90`
  - `fitness/checks-typescript/src/checks/security/sql-injection.ts:317`
  - `fitness/checks-typescript/src/checks/security/input-sanitization.ts:236`
- **Pattern / principle:** The Liskov-substitution / least-astonishment
  principle. Two functions advertised as "parse TS source" should behave
  the same way modulo the documented difference.
- **Status:** **Open — silent perf cliff.** The other ~50 callers route
  through `getSharedSourceFile`, which uses the language-aware parse cache
  and reuses the same `ts.SourceFile` across every check that touches the
  same file in a single fitness run. The four callers above re-parse the
  same file once per check, and during a multi-check run that means each
  file in scope gets re-parsed N times where N is the number of checks
  using `parseSource` directly. With four checks doing this it's
  4× redundant parse work per file in the worst case.
- **Why it matters:** The cache exists exactly to avoid this; the public
  `parseSource` is functionally a footgun. A check author reading the
  barrel sees `parseSource` and `getSharedSourceFile` side-by-side with no
  hint that one is dramatically slower at scale.
- **Recommendation:**
  - Mark `parseSource` `@deprecated` with a pointer to `getSharedSourceFile`
    OR rename it to `parseSourceUncached` to make the trade-off explicit at
    the call site.
  - Migrate the four call sites to `getSharedSourceFile`.
  - Long-term: `parseSource` could become an internal export only, used
    inside `parse-cache` from core. The public API would be
    `getSharedSourceFile` (or rename to `parseSource` and have it always
    cache-aware).

### The `query` API has zero runtime consumers and is partially redundant with the adapter's typed surface

- **Files / code:** `src/query.ts` (entire file), `src/index.ts` line 4
  (re-export). Defined in `packages/core/src/languages/adapter.ts`
  (`LanguageQueryAPI`).
- **Pattern / principle:** YAGNI. ISP — don't ship interfaces nobody asks
  for.
- **Status:** **Open — speculative API, untested in production.**
  Searching the workspace, only `query.ts` itself, the `adapter.test.ts`
  test file, and the type definition consume `findFunctions`,
  `findImports`, `findCallsTo`, or `findStringLiterals`. The actual checks
  in `checks-typescript` walk the AST themselves with `walkNodes` from
  `ast-utilities`. The `query` field is on the `LanguageAdapter` interface
  in core but nothing in core or fitness actually invokes it.
- **Why it matters:**
  - `findCallsTo(tree, name)` matches by leaf method name only — it'd return
    `console.log` AND a hand-written `obj.log()`. That's almost certainly
    not what callers would want; the call-graph signal needs receiver
    context. The fact that no production code uses it means the bug has
    never been exercised.
  - The cross-language `query` shape buys an abstraction (Location, Import,
    GenericFunction) that no other lang adapter implements (rust, python,
    java, go, cpp all skip the optional `query` slot). So it's only
    half-shaped: TS has the structure, no other lang fills it in, and no
    consumer demands it.
  - The implementation has its own private `walk` function (lines 11–14),
    duplicating `walkNodes` from `ast-utilities` (lines 48–54).
- **Recommendation:**
  - Pick a direction in the next architecture decision: either commit to
    the cross-language `query` API and have the other lang adapters
    implement it (with a real consumer in checks-universal driving the
    requirement), or remove the `query` slot from `LanguageAdapter` and
    delete `query.ts`. Don't keep it in limbo.
  - If kept: fix `findCallsTo` to take a receiver path (e.g.
    `findCallsTo(tree, { receiver: 'console', method: 'log' })`) so it
    isn't a near-miss helper, and consolidate the private `walk` with
    `walkNodes` so there's one walker.

### `lang-no-fitness-except-typescript` exception inverts layering — `filterContent` is in the wrong package

- **Files / code:**
  - `src/strip.ts` lines 9, 16, 23, 29: `import { filterContent } from
    '@opensip-tools/fitness'` and re-export.
  - `.dependency-cruiser.cjs` lines 187–199: the `lang-no-fitness-except-typescript`
    exception rule itself.
  - `fitness/engine/src/framework/content-filter.ts`: where `filterContent`
    actually lives.
- **Pattern / principle:** Layering / Dependency Inversion. The kernel /
  contract layer (lang adapters) must not depend on the engine layer
  (fitness). The exception is a known smell; the question is whether to
  pay it down or settle.
- **Status:** **Open — should be paid down, not settled.** Today's setup
  has lang-typescript reach back UP into fitness for `filterContent`, then
  `applyContentFilter` in core dispatches to `adapter.stripStrings` /
  `adapter.stripComments`, which call back into fitness. That's a functional
  cycle (core → lang adapter → fitness → ...) that only doesn't bite at
  build time because TS module resolution is happy with it. The CLAUDE.md
  for this repo even says "If you need to violate a rule, the right move
  is usually to refactor the shared piece into core."
- **Why it matters:**
  - `filterContent` is a TS-aware string/comment stripper. It's not
    fitness-domain logic — there's nothing about checks, recipes, or
    targets in it. Naming aside, it's exactly what
    `typescriptAdapter.stripStrings/stripComments` should do natively.
  - Because the rule has an exception, future contributors will see the
    "lang-typescript can import from fitness" pattern as precedent and
    push to extend it. The rule's `pathNot` clause keeps that contained,
    but the principle ("lower layer reaches up") is being normalized.
  - The duplicated stripper logic in fitness's
    `framework/strip-literals.ts` (`stripStringLiterals`,
    `stripStringsAndComments`) and `framework/content-filter.ts`
    (`filterContent`) is itself a smell — at least one of those is a
    legacy implementation.
- **Recommendation:**
  - Move `filterContent` (and `clearFilterCache`, `FilteredContent`)
    from `fitness/engine/src/framework/content-filter.ts` to
    `lang-typescript/src/strip.ts` (or a new `src/filter.ts`). It's
    TS-specific, position-aware, and consumed by exactly one TS-aware
    path. fitness re-exports the moved symbols for backward compat,
    delete the back-edge import, delete the dep-cruiser exception.
  - As a follow-up, deduplicate against
    `framework/strip-literals.ts`. Pick one stripper, retire the other.

### Subpath exports (`./adapter`, `./parse`, `./query`, `./strip`, `./ast-utilities`) have zero external consumers

- **Files / code:** `packages/languages/lang-typescript/package.json` lines
  18–25 (`exports` map). Codebase-wide grep for
  `'@opensip-tools/lang-typescript/<sub>'` returns no hits outside this
  package's own internal imports.
- **Pattern / principle:** ISP done right means clients import only what
  they use. ISP done wrong means publishing a fragmented surface that
  forces clients to think about internal layout.
- **Status:** **Open — fragmenting the public API for no benefit.** The
  five subpath exports ship five extra public commitments (each subpath is
  semver-stable once published) for zero realized benefit. The CLAUDE.md
  even calls this out: "Subpath exports are strongly discouraged; prefer
  the package barrel." The `parse-cache.js` exception in core is named
  explicitly as the only sanctioned subpath. lang-typescript adds five
  more without that justification.
- **Why it matters:**
  - Once published to npm, removing or renaming any of the five subpaths
    is a major version bump.
  - Tree-shaking benefits are nil — bundlers handle barrel files fine and
    nobody is consuming this package in a bundle anyway (it's a Node CLI
    plugin).
  - The `./ast-utilities` subpath, in particular, exposes the duplicated
    `parseSource` (Finding 2) directly to any consumer that imports it,
    which makes that bug harder to clean up without a major.
- **Recommendation:**
  - Drop all five subpath exports. Keep only `.` (the barrel). Verify no
    external consumer depends on a subpath (none do today).
  - If a future need arises (e.g. a parser-only ESM artifact), add the
    subpath at that point. Don't speculatively publish them.
  - This is best done before the next major version, since removing
    subpath exports IS a breaking change for any cached node_modules.

### `ts` namespace re-export is duplicated between `lang-typescript` and `fitness` — pick one home

- **Files / code:**
  - `lang-typescript/src/ast-utilities.ts:238`: `export { ts }`
  - `fitness/engine/src/index.ts:34–35`: `import * as _ts from 'typescript'; export { _ts as ts };`
- **Pattern / principle:** Single source of truth; consistency.
- **Status:** **Open — both places re-export, callers are inconsistent.**
  Looking at the 50+ checks: most checks importing `ts` import it from
  `@opensip-tools/fitness` (e.g. `sql-injection.ts:9` does `import {
  defineCheck, type CheckViolation, getASTLineNumber, ts } from
  '@opensip-tools/fitness'`). The lang-typescript version exists for the
  same purpose but is rarely consumed directly. Both re-exports carry the
  same eslint-disable comment about `export = ` semantics.
- **Why it matters:**
  - There's no lower-layer reason for fitness to re-export the TS compiler
    API namespace. fitness is the engine; the TS compiler API belongs to
    the lang pack.
  - As long as both re-export, check authors will pick whichever is in
    their existing import, fragmenting consistency. The dep-cruiser
    `lang-no-fitness-except-typescript` rule covers `filterContent` but
    not `ts` re-export — they're tracking the same mistake.
  - Removing one is straightforward: the namespace identity is the same
    object either way; only the import path changes.
- **Recommendation:**
  - Decide that `ts` lives in `@opensip-tools/lang-typescript` (the right
    layer). Add it to the barrel as a top-level export
    (currently it's only via `./ast-utilities`).
  - Remove the `ts` re-export from `fitness/engine/src/index.ts` lines
    33–36. Migrate the ~5 checks that import `ts` from fitness.
  - This pairs naturally with the `filterContent` move (Finding 5):
    they're the same kind of misplacement.

### Plugin contract export `adapters` is consistent but lacks a runtime check

- **Files / code:** `src/adapter.ts:21`: `export const adapters =
  [typescriptAdapter] as const`. Compare with rust:
  `lang-rust/src/adapter.ts:17` (same shape).
- **Pattern / principle:** Plugin contract uniformity.
- **Status:** **Minor / informational — settled.** Every lang pack exports
  the same `adapters` array. The plugin loader picks it up via discovery.
  No issue today.
- **Why it matters:** If a future lang pack drifts (e.g. exports
  `languageAdapter` instead of `adapters`), the plugin loader will silently
  skip it and the failure mode is "TS files aren't analyzed" with no error
  message.
- **Recommendation:** Not a finding for lang-typescript per se — flag for
  the plugin loader audit: validate plugin shapes at load time and emit a
  named error when an `opensipTools.kind: 'lang'` package's main module
  doesn't export an `adapters` array.

## Non-findings considered and dismissed

- **`ts.SourceFile` / `ts.Node` in the public API** — the `LanguageAdapter`
  contract is explicitly type-parametric (`<TTree, TNode>`); the lang pack
  is required to bind concrete types. The leak is the design. Not a
  finding.
- **`parse.ts` returning `null` on failure instead of throwing** — matches
  the `LanguageAdapter.parse` contract ("Returns null on parse failure").
  Other lang adapters do the same.
- **No `warmup` implementation** — the contract has `warmup?` as optional;
  the TS compiler has nothing to warm up (no WASM init like tree-sitter).
  Skipping it is correct.
- **`countUnescapedBackticks` lives in `ast-utilities.ts` despite being a
  pure string util, not an AST helper** — it's misfiled but the cost of
  moving it is greater than the reward (3 callers in checks-typescript).
  Worth fixing during the `ast-utilities` split (Finding 1) but not on its
  own merits.
- **`parseSource` swallowing all errors with `catch {}`** — the TS parser
  is itself extremely forgiving (the test in `adapter.test.ts:20` confirms
  even broken input parses to a SourceFile), so the catch is rarely hit.
  Argument for adding a debug log instead of silent null exists but is
  small beer.
- **No tests for `query.ts` beyond what's in `adapter.test.ts`** — given
  Finding 4 (no production consumers), the coverage gap is the right size
  for the API's actual use. Adding tests before deciding whether to keep
  the API would be over-investment.
- **`fileExtensions` includes `.js`/`.jsx`/`.mjs`/`.cjs`** — matches the
  parse path's actual capability (TS compiler API parses JS happily). The
  alias list (`'javascript', 'tsx', 'jsx', 'js'`) covers legacy scope
  strings. Both are correct.
- **`getSharedSourceFile` returning `null` instead of throwing** —
  consistent with `LanguageAdapter.parse`. Callers handle null.
