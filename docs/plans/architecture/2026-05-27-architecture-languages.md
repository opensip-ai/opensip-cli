# Architecture audit — languages

**Date:** 2026-05-27
**Scope:** packages/languages/lang-* (lang-typescript, lang-python, lang-go, lang-java, lang-rust, lang-cpp) plus the `core/languages/*` surface they implement against
**Auditor:** Claude

## Summary

The languages namespace is, on the whole, a textbook Adapter pattern over the
`LanguageAdapter` contract: each pack implements one adapter (`xAdapter`), an
`adapters` plugin-export array, a strip module, and (for everyone except cpp)
a parse module. Five of the six packs follow that shape almost identically;
lang-typescript is the outlier — it is the only pack with a meaningful AST,
the only one that ships a `LanguageQueryAPI` implementation, and it carries a
large amount of accreted history (the `ast-utilities.ts` "legacy shim", the
`filter.ts` content filter with its own cache, multiple `isInComment` style
helpers, a re-export of the `ts` namespace).

The strongest finding is **dispatch already does this**: the Adapter contract
+ `applyContentFilter` + `LanguageRegistry` correctly externalise the
"different stripper per language" problem (Strategy + Adapter, well used).
The weaknesses cluster in two places:

1. **Inconsistency across the peer tier**: subpath imports from core, parse
   return types, alias coverage, package `exports` shape, and AST-helper
   surface area diverge between lang-typescript and everyone else. Most of
   these are cosmetic; one (parse-cache subpath import) signals an
   abstraction leak.

2. **lang-typescript carries un-extracted abstractions** that other packs
   would benefit from once they grow real AST parsers: a per-package parse
   cache (`filter.ts`), a separate `isInComment`/`isInString` API distinct
   from the contract's `query`, and a `query` object that nobody calls. The
   `LanguageQueryAPI` Bridge is half-built — fully designed but with zero
   non-TS implementations and zero consumers.

Findings below prioritise the cross-pack consistency lens, since that is the
explicit goal of the languages layer.

## Findings

### F1 — Subpath imports from `@opensip-tools/core/languages` only in lang-typescript

- **Files:**
  - `packages/languages/lang-typescript/src/adapter.ts:7`
  - `packages/languages/lang-typescript/src/query.ts:3-4`
  - `packages/languages/lang-typescript/src/ast-utilities.ts:15`
  - `packages/languages/lang-typescript/src/filter.ts:11`
  - All other packs at e.g. `packages/languages/lang-go/src/adapter.ts:5`, `packages/languages/lang-rust/src/strip.ts:20-26`
- **Principle/Pattern:** Dependency Inversion / module-boundary hygiene
- **Status:** Problematic
- **Evidence:** `lang-typescript/adapter.ts:7` does
  `import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'`
  while `lang-rust/adapter.ts:5` does
  `import type { LanguageAdapter } from '@opensip-tools/core'`. Same for
  `LanguageQueryAPI`, `GenericFunction`, `Location`, `getParseTree`, and
  `buildLineStarts` — all available from the package barrel
  (`packages/core/src/index.ts` re-exports `./languages/index.js`), but
  lang-typescript reaches past it.
- **Why it matters:** CLAUDE.md calls out `@opensip-tools/core/languages/parse-cache.js` as **the one allowed subpath exception** for lang adapters. lang-typescript currently uses *four* different subpaths (`/adapter.js`, `/generic-types.js`, `/parse-cache.js`, `/languages` (no `.js`)). Either the exception is too narrow (and should be widened to "lang adapters may use `@opensip-tools/core/languages/*`") or lang-typescript is in violation — the inconsistency means nobody can tell. It also makes it harder to slim core's `exports` map later without breaking lang-typescript silently.
- **Recommendation:** Pick one boundary. The simplest is "lang-* packs import everything from the `@opensip-tools/core` barrel; the `parse-cache.js` subpath exists only for direct re-export use by core itself." Tighten lang-typescript's imports to the barrel and either remove the `./languages/*` wildcard from `packages/core/package.json:exports` or document the exception precisely in CLAUDE.md.

### F2 — `parse-cache.js` subpath exception is no longer earning its keep

- **Files:**
  - `packages/core/package.json` (exports map)
  - `packages/core/src/languages/parse-cache.ts:131-140` (`getParseTree`)
  - `packages/core/src/languages/index.ts:5-10` (already re-exported)
  - `packages/languages/lang-typescript/src/ast-utilities.ts:15`
- **Principle/Pattern:** Interface Segregation / module barrel discipline
- **Status:** Missing opportunity
- **Evidence:** `getParseTree`, `initParseCache`, `clearParseCache`,
  `getParseTreeForFile`, and `LanguageParseCache` are all re-exported from
  `packages/core/src/languages/index.ts`, which is in turn re-exported from
  `packages/core/src/index.ts`. The only place anyone reaches past the barrel
  is `lang-typescript/ast-utilities.ts:15`. CLAUDE.md justifies the subpath
  as "used by language adapters" — but the other five adapters don't use it
  at all (their MVP `parse()` returns a `MinimalTextTree` factory result and
  no caller round-trips through `getParseTree`).
- **Why it matters:** The subpath was introduced (per the source comment in
  `parse-cache.ts`) so adapters could pull just the cache without dragging
  in the rest of core. That argument made sense when core was much wider;
  today the whole `languages/index.ts` surface is small (~30 named exports)
  and lang-typescript already pulls `logger` from the barrel
  (`filter.ts:10`). The "exception" is purely historical.
- **Recommendation:** Delete `"./languages/*": "./dist/languages/*"` from
  `packages/core/package.json`, change `lang-typescript/ast-utilities.ts:15`
  to import `getParseTree` from `@opensip-tools/core`, and remove the
  exception sentence from CLAUDE.md. If a future lang pack genuinely needs
  to opt out of the barrel for bundle-size reasons, re-introduce the
  exception with a real consumer.

### F3 — `LanguageAdapter.parse` return type is inconsistently honoured

- **Files:**
  - `packages/core/src/languages/adapter.ts:34` (contract: `TTree | null`)
  - `packages/languages/lang-rust/src/parse.ts:31` (returns `RustTree`, no null)
  - `packages/languages/lang-go/src/parse.ts:21` (returns `GoTree`, no null)
  - `packages/languages/lang-java/src/parse.ts:21` (returns `JavaTree`, no null)
  - `packages/languages/lang-python/src/parse.ts:21` (returns `PythonTree | null`)
  - `packages/languages/lang-typescript/src/parse.ts:10` (returns `ts.SourceFile | null`)
  - `packages/languages/lang-cpp/src/adapter.ts:25` (`parse: () => null`)
- **Principle/Pattern:** Liskov Substitution / contract honesty
- **Status:** Problematic
- **Evidence:** The contract says every adapter may return `null` to signal
  parse failure. Only TS and Python signal this in their return type;
  lang-rust/go/java declare a non-null return and structurally widen
  through the adapter assignment. lang-cpp's `parse` is hard-wired to
  `null`. Test in `lang-rust/__tests__/adapter.test.ts:15-18` asserts
  `expect(tree).not.toBeNull()` — i.e. the test acknowledges the contract
  *could* return null even though the implementation can't.
- **Why it matters:** Two downstream consequences. (a) Consumers like
  `getParseTreeForFile` (`parse-cache.ts:146`) and every check that calls
  `getSharedSourceFile` have to handle `null`, but for four languages the
  null branch is dead code — silently. (b) When tree-sitter integration
  lands (as the parse.ts docstrings forecast) the return type will
  *expand*, which Python-style consumers handle but Rust/Go/Java-style
  consumers won't, because their type pinky-swore null was impossible. The
  inconsistency makes it impossible to write a generic "if parse failed,
  log and skip" helper.
- **Recommendation:** Either (a) tighten the contract — `parse(): TTree |
  null` for adapters that can actually fail, drop null for adapters that
  cannot, and make the registry typed so consumers can branch correctly;
  or, more pragmatically, (b) normalize all `parse*` functions in lang-*
  packs to `XTree | null` today so the migration to tree-sitter is a
  one-line change to the body, not a return-type change visible to every
  caller. Option (b) is cheaper.

### F4 — `LanguageQueryAPI` is a half-built Bridge — designed, implemented once, consumed zero times

- **Files:**
  - `packages/core/src/languages/adapter.ts:7-14` (interface)
  - `packages/languages/lang-typescript/src/query.ts:16` (only implementation)
  - `packages/languages/lang-typescript/src/__tests__/query.test.ts` (only test)
- **Principle/Pattern:** Bridge / cross-language abstraction
- **Status:** Problematic (Speculative Generality)
- **Evidence:** `grep -rn 'typescriptQuery\|LanguageQueryAPI'` across all
  non-`dist` source returns the definition, the lang-typescript
  implementation, and one test. No check pack, no graph pack, no
  simulation pack calls `.query?.findFunctions` or any of the other
  methods.
- **Why it matters:** Bridge is a useful pattern when you have ≥2
  implementations and ≥1 consumer that wants to vary independently of the
  concrete language. With one impl and zero consumers, it's overhead:
  every future lang adapter has to decide whether to implement it
  (`adapter.query` is optional, so most won't) and every reader has to
  wonder why the symbol exists. It also competes with the per-pack AST
  helper exports (`findCallExpressions`, `walkNodes`, …) — those are the
  real API checks use.
- **Recommendation:** Either retire it (delete `typescriptQuery`, the
  `query` field on `LanguageAdapter`, `GenericFunction`, and `Import`) and
  reintroduce when a concrete consumer materialises, or commit to it by
  having graph-typescript / checks-universal route through `query` instead
  of importing TS-specific helpers. The current middle ground costs
  cognitive surface area without delivering the polymorphism it promises.

### F5 — Per-package "second cache" in lang-typescript bypasses the unified parse cache

- **Files:**
  - `packages/languages/lang-typescript/src/filter.ts:145-167` (`filterCache`, `clearFilterCache`)
  - `packages/core/src/languages/parse-cache.ts:108-121` (`activeCache`, `clearParseCache`)
  - `packages/fitness/engine/src/recipes/service.ts:176` (clears only parse cache)
- **Principle/Pattern:** Single Responsibility / Resource Lifecycle
- **Status:** Problematic
- **Evidence:** lang-typescript maintains a *separate* module-level
  `filterCache` Map with its own 10-minute idle timer, distinct from
  `LanguageParseCache`. The header comment at `filter.ts:127-144` already
  flags this as audit F-M2 and notes "embedders that want a clean slate
  must call BOTH `clearParseCache()` and `clearFilterCache()`." The
  fitness service calls only the former (`service.ts:176`).
- **Why it matters:** This is two-cache hidden coupling. A long-lived
  embedder (a dev-server fitness loop, a future LSP integration) clears
  state between runs and gets stale `FilteredContent` because the second
  cache is invisible from the registry. The bug is contained today only
  because the same content keying means the cache *coincidentally* stays
  valid; any future change to content normalisation will break this
  silently.
- **Recommendation:** Unify both caches under a `LanguageCache` registry
  in core (one timer, one `clear()` entry point) and let lang-typescript
  publish a "post-scan" decoration on the existing parse cache entry
  rather than maintaining a parallel store. Until then, at minimum have
  `clearParseCache()` invoke any registered "secondary" cache cleaners
  via a publish/subscribe hook.

### F6 — `isInComment` exists twice, with different signatures, in lang-typescript

- **Files:**
  - `packages/languages/lang-typescript/src/ast-utilities.ts:199` — `isInComment(position: number, sourceFile: ts.SourceFile): boolean`
  - `packages/languages/lang-typescript/src/filter.ts:39` — `isInComment(line: number, column: number) => boolean` (on `FilteredContent`)
- **Principle/Pattern:** Single Responsibility / naming clarity
- **Status:** Problematic
- **Evidence:** Two exported helpers both named `isInComment`, with
  different coordinate systems (byte position vs (line, column)) and
  different "what counts as a comment" semantics (TS `getLeadingCommentRanges`
  vs scanner-recorded `commentRegions`). The barrel re-exports the
  ast-utilities one; the filter one is only accessed via a `FilteredContent`
  value, so they don't clash in the import surface — but a check author
  reading checks-typescript can't tell which they want without diving.
- **Why it matters:** Same name, different behaviour is the textbook
  recipe for subtle false-positive/false-negative skews in checks. The
  ast-utilities version walks line ranges; the filter version uses the
  scanner. They are *not* equivalent — e.g. for a position inside a
  template literal containing a comment-shaped substring, they disagree.
- **Recommendation:** Rename one. Likely `isPositionInComment` for the
  byte-offset variant in ast-utilities and `isLocationInComment` (or a
  method on `FilteredContent.regions`) for the line/column variant. Same
  treatment for `isInString` / `isInStringLiteral`. While you're there,
  consider promoting the comment/string region predicate into the
  `LanguageAdapter` surface — it's clearly cross-language-useful (the
  scanner trio in `core/strip-utils.ts` already produces region lists).

### F7 — Alias coverage is uneven across packs

- **Files:**
  - `packages/languages/lang-typescript/src/adapter.ts:13` — `aliases: ['javascript', 'tsx', 'jsx', 'js']`
  - `packages/languages/lang-rust/src/adapter.ts:9` — `aliases: ['rs']`
  - `packages/languages/lang-go/src/adapter.ts:9` — `aliases: ['golang']`
  - `packages/languages/lang-python/src/adapter.ts:10` — `aliases: ['py']`
  - `packages/languages/lang-cpp/src/adapter.ts:24` — `aliases: ['c']`
  - `packages/languages/lang-java/src/adapter.ts` — **no aliases declared**
- **Principle/Pattern:** Consistency / Principle of Least Surprise
- **Status:** Problematic
- **Evidence:** Every pack except lang-java declares at least one alias.
  Java users typing `languages: ['jvm']` or `languages: ['j']` in
  `opensip-tools.config.yml` get a silent no-match — the canonicalize
  fallback in `registry.ts:115` only succeeds for the literal canonical
  id `'java'`.
- **Why it matters:** Targets and check scopes are user-authored YAML. The
  documented affordance "you can write the short form" only works for five
  out of six languages. There's no documented rule for *what* qualifies as
  an alias either — `golang` (full name), `py` (short), `rs` (extension),
  `c` (sibling language), `javascript` (synonym) — so a contributor adding
  Ruby or Swift has no precedent to follow.
- **Recommendation:** Define a tiny "alias policy" in `core/languages/`
  README (short extension + common synonyms + adjacent language siblings),
  add Java aliases (`jvm`? — debatable; at minimum nothing seems to be the
  Java equivalent of `golang`, so this finding may resolve as
  "intentional"). Either way, document the absence so it isn't an
  oversight.

### F8 — Adapter package `exports` maps drift between packs

- **Files:**
  - `packages/languages/lang-typescript/package.json` (six entries including `./ast-utilities`, `./query`)
  - `packages/languages/lang-rust|java|go|python/package.json` (four entries each: `.`, `./adapter`, `./parse`, `./strip`)
  - `packages/languages/lang-cpp/package.json` (three entries: `.`, `./adapter`, `./strip` — no parse)
- **Principle/Pattern:** Module-boundary consistency
- **Status:** Problematic (low severity)
- **Evidence:** Each pack exposes subpath exports for its source files,
  but the menu is per-pack. lang-typescript ships `./query` and
  `./ast-utilities`; nobody imports `./query` (F4), and `./ast-utilities`
  is described in the source header as a "legacy shim". The Python pack
  has its own scanner and *could* be reaching into `core/strip-utils.ts`
  but doesn't — and its `./parse` subpath exposes a trivial 3-line
  wrapper.
- **Why it matters:** Subpath exports are a forward-compat hazard — every
  one is a contract you have to honour in a future major bump. The
  CLAUDE.md guidance ("Subpath exports are strongly discouraged; prefer
  the package barrel") is being followed in spirit by the smaller packs
  (their subpaths are never imported by callers) but lang-typescript's
  `./query` and `./ast-utilities` could be silently consumed.
- **Recommendation:** Drop every per-file subpath that isn't actually
  imported by callers (audit via `grep`). Keep only `.` (barrel). The
  packs that do this — checks-typescript at first glance — already
  consume the barrel only.

### F9 — Python pack deliberately diverges from the core scanner abstraction with no migration path

- **Files:**
  - `packages/languages/lang-python/src/strip.ts:20-29` (explanatory comment)
  - `packages/core/src/languages/strip-utils.ts:88-117` (the `scanRegularString` it doesn't use)
- **Principle/Pattern:** DRY / Open-Closed
- **Status:** Problematic
- **Evidence:** The Python pack hand-rolls `scanTripleString` and
  `scanSingleString` (`strip.ts:122-190`) with a comment that says: "this
  pack deliberately does NOT consume the C-family scanners… If a second
  adopter (Ruby, Bash, Swift) appears, the right move is to lift a
  parameterized `scanQuotedString(quoteChar)` into core; with one
  consumer it stays here."
- **Why it matters:** The decision is reasonable today, but the comment
  is a tripwire that will not get pulled. The next adopter (Ruby, Swift)
  will look at `scan*` in core, see they don't fit, and write their own
  — repeating the exact divergence the comment warned about. The
  *abstraction* gap is real: core has scanners hard-coded for `"`, and
  Python/Ruby/Swift all need single-quote-or-double-quote parity. The
  pattern that fits is Template Method / parameterized scanner: pass the
  quote char.
- **Recommendation:** Either lift `scanQuotedString(quoteChar)` into
  `core/strip-utils.ts` now (small refactor, makes Python's strip module
  ~30 lines shorter and the C-family scanners no harder to read), or
  delete the predictive comment to avoid lying to future contributors.
  Preference: lift now — Python's two scanners are essentially the
  C-family `scanRegularString` with one parameter generalised, and the
  test in `lang-python/__tests__/strip.test.ts` already exercises both
  quote shapes.

### F10 — Char-literal `maxScan` cap is a per-call magic number

- **Files:**
  - `packages/languages/lang-go/src/strip.ts:86` — `{ maxScan: 12 }`
  - `packages/languages/lang-java/src/strip.ts:126` — default (`8`)
  - `packages/languages/lang-cpp/src/strip.ts:124` — `{ maxScan: 12 }`
  - `packages/languages/lang-rust/src/strip.ts:142` — inline custom scan (does NOT use the shared helper)
  - `packages/core/src/languages/strip-utils.ts:286-289` — default cap doc
- **Principle/Pattern:** Strategy parameterisation / shared knowledge
- **Status:** Problematic (low severity)
- **Evidence:** Each adopter picks its own `maxScan`. The core docstring
  says "8 — matches the lang-java / lang-rust heuristic. lang-cpp
  overrides this to 12 to accommodate unicode escapes…" — but lang-go
  *also* overrides to 12, and lang-rust doesn't use the shared helper at
  all (re-implements the scan inline because of the lifetime-vs-literal
  branch).
- **Why it matters:** The "8 default" doesn't actually represent any
  language — Java works with it accidentally (Java char literals don't
  use `\U` escapes), C++/Go need more, Rust needs the helper plus a
  pre-branch. A reader of `strip-utils.ts` who sees the default thinks
  it's a load-bearing language constant; it isn't.
- **Recommendation:** Change the default to the maximum needed by any
  C-family language (Rust's `\u{XXXXXX}` is the longest at ~10 chars
  between quotes, so 12 is safe) and drop the per-call overrides from
  lang-go/lang-cpp. Or: name the constant — `MAX_C_FAMILY_CHAR_LITERAL`
  in core — and reference it by name from each call site so the magic
  number is explained once.

### F11 — lang-rust re-implements the char-literal scanner instead of using the shared helper

- **Files:**
  - `packages/languages/lang-rust/src/strip.ts:125-167`
  - `packages/core/src/languages/strip-utils.ts:306-349` (shared `scanCharLiteral`)
- **Principle/Pattern:** Template Method / Open-Closed
- **Status:** Problematic
- **Evidence:** The Rust pack's char branch has a 40-line inline scanner
  with its own `escape`/`foundClose` flags. Comments at line 132-141
  acknowledge "Core's `scanCharLiteral` helper *does* distinguish
  overflow from success (overflow returns `end === start + 1`, success
  returns `end > start + 1`), so a migration to that helper with a
  `result.end === i + 1` lifetime branch is feasible." Then doesn't do
  it.
- **Why it matters:** Two scanners that should be one. They drift —
  e.g. the Rust scanner caps at 8 (`i + 8`, line 142) but the helper's
  default is 8 and lang-cpp uses 12 for unicode escapes — Rust supports
  `'\u{1F600}'` too, so its cap is wrong. The shared helper would fix
  that for free if used.
- **Recommendation:** Replace the inline scanner with a
  `scanCharLiteral(src, i, { maxScan: 12 })` call, branching on
  `result.end === i + 1` to mean "lifetime, not literal". The
  load-bearing branch order is already correct in the helper. Net delta:
  ~30 fewer lines in lang-rust, one fewer place for the char-literal
  invariant to live.

### F12 — `MinimalTextTree` is a true Bridge between MVP packs and core — well used

- **Files:**
  - `packages/core/src/languages/text-tree.ts:28-53`
  - Adopted by `lang-go/parse.ts`, `lang-java/parse.ts`, `lang-rust/parse.ts`, `lang-python/parse.ts`
- **Principle/Pattern:** Bridge / Factory
- **Status:** Correct
- **Evidence:** Four MVP packs delegate `parse()` to `buildMinimalTextTree`
  and brand their own `XTree` alias over `MinimalTextTree`. The
  brand-alias trick (`export type GoTree = MinimalTextTree`) leaves room
  for an unbranded tree-sitter type to grow later without changing the
  adapter's generic parameter.
- **Why it matters:** This is exactly the right shape for "shared
  primitive, distinct identity per consumer". It contrasts with F4 where
  `LanguageQueryAPI` failed to grow consumers and stayed speculative —
  this Bridge has all four expected adopters and is load-bearing.
- **Recommendation:** None. Hold the line; when tree-sitter lands, widen
  one pack at a time without touching the bridge.

### F13 — Shared C-family scanner family is well-extracted (Template Method done right)

- **Files:**
  - `packages/core/src/languages/strip-utils.ts:88-369`
  - Adopted by `lang-go/strip.ts`, `lang-java/strip.ts`, `lang-rust/strip.ts`, `lang-cpp/strip.ts`
- **Principle/Pattern:** Template Method + Strategy (per-language outer scanner driving shared inner scanners)
- **Status:** Correct
- **Evidence:** Five shared scanners (`scanRegularString`,
  `scanLineComment`, `scanBlockCommentNonNesting`,
  `scanBlockCommentNesting`, `scanCharLiteral`) parameterised by tight
  option objects (`allowMultiline`, `allowLineContinuation`, `maxScan`).
  Each pack composes them with language-specific outer logic (raw
  strings, text blocks, prefix matching). The shared layer is purely
  language-agnostic by construction.
- **Why it matters:** This is the abstraction the CLAUDE.md layering
  rules were designed to enable — lang-* packs can't import each other,
  but they can all share through core. The pattern works.
- **Recommendation:** None for the abstraction itself; see F9-F11 for
  individual pack divergences from it.

### F14 — lang-typescript barrel exports the `ts` namespace from two places

- **Files:**
  - `packages/languages/lang-typescript/src/index.ts:8-9` (top-level `export { ts }`)
  - `packages/languages/lang-typescript/src/ast-utilities.ts:232-233` (also `export { ts }`)
- **Principle/Pattern:** Single Source of Truth
- **Status:** Problematic (low severity)
- **Evidence:** Both files do `import * as ts from 'typescript'; export
  { ts }`. The barrel re-exports from `ast-utilities`
  (`index.ts:36-51`), so `ts` is double-exported. The index.ts comment
  says "the `ts` re-export from this module is intentionally NOT
  re-surfaced here (it now lives at the top of the barrel above)" — but
  the ast-utilities re-export still exists, and because it's at the same
  symbol name TypeScript silently dedupes.
- **Why it matters:** Either of the two could be deleted without
  consequence. Leaving both invites the next refactor to pick the wrong
  one. The "legacy shim" framing of ast-utilities is the only signal
  about which should win, and that's a comment, not code.
- **Recommendation:** Delete the `export { ts }` block from
  `ast-utilities.ts:232-233`. The header comment in `index.ts:8` already
  documents the canonical location.

### F15 — `warmup()` is in the contract but never invoked

- **Files:**
  - `packages/core/src/languages/adapter.ts:45-46`
  - `grep -rn "warmup" packages --include='*.ts'` returns only the declaration
- **Principle/Pattern:** Interface Segregation
- **Status:** Problematic (low severity — speculative)
- **Evidence:** `LanguageAdapter.warmup?(): Promise<void>` is declared as
  "Called by CLI bootstrap" but no code path in the CLI calls it. No
  current adapter implements it.
- **Why it matters:** Same shape as F4 — a contract method that no
  consumer calls and no implementor honours. When tree-sitter lands and
  a pack actually needs warmup, the wiring will have to be added to the
  CLI anyway, and at that point either (a) the existing method is the
  right shape (great) or (b) it isn't (and you've maintained dead API
  for nothing).
- **Recommendation:** Either remove the method (re-add when first
  needed) or add a CLI bootstrap that walks the registry and awaits
  `warmup` on each adapter — even a no-op invocation cements the
  contract. The current state (declared but never called) is the worst
  of both.

### F16 — `register-language-adapters.ts` enumerates packs by hand — duplicates the plugin-discovery flow

- **Files:**
  - `packages/cli/src/bootstrap/register-language-adapters.ts:17-37`
  - `packages/core/src/plugins/types.ts:29-31` (`LangPluginExports.adapters`)
  - Each lang pack exports `adapters` (e.g. `lang-rust/adapter.ts:17`)
- **Principle/Pattern:** Open-Closed / Strategy registration
- **Status:** Problematic (low severity)
- **Evidence:** Every lang pack exports an `adapters = [xAdapter] as
  const` plugin contract — but the CLI bootstrap registers the singular
  `xAdapter` symbol from each by name, not the plural `adapters` array.
  So bundled packs are wired through the imperative list, and only
  third-party packs go through the plugin-discovery path.
- **Why it matters:** Two registration paths for the same contract. A
  bundled pack that needs to ship two adapters (e.g. a "TS strict" and
  "TS lax" pair, or a hypothetical "C" + "C++" split) has to remember to
  update the CLI bootstrap. The plugin-discovery flow handles N adapters
  per pack already.
- **Recommendation:** Have the bootstrap iterate over `adapters` arrays:
  `for (const a of [...rustPkg.adapters, ...goPkg.adapters, …])
  registry.register(a)`. Same result, one registration code path. Plus
  it tests the plugin-export contract on the bundled packs.

### F17 — lang-typescript's `walkNodes` and `query.walk` are two implementations of the same recursion

- **Files:**
  - `packages/languages/lang-typescript/src/ast-utilities.ts:43-49` (`walkNodes`, excludes root)
  - `packages/languages/lang-typescript/src/query.ts:11-14` (`walk`, includes root)
- **Principle/Pattern:** DRY / Composite
- **Status:** Problematic (low severity)
- **Evidence:** Two slightly different tree walkers in the same package.
  The query.ts one visits the root; ast-utilities.ts one skips it. Each
  uses `ts.forEachChild` recursion.
- **Why it matters:** Same name pattern (walk vs walkNodes) tells the
  reader "these probably do the same thing"; they don't. Any check that
  pastes between the two surfaces inherits the subtle visiting
  difference.
- **Recommendation:** One walker. Add a `{ visitRoot?: boolean }` option
  to `walkNodes` and have `query.ts` call it. The query module's `walk`
  becomes a one-liner.

## Strengths

- **Adapter contract is clean and minimal.** `LanguageAdapter` has six
  required fields (id, extensions, parse, stripStrings, stripComments,
  plus optional aliases/query/warmup) and that's all checks need.
  Generic `TTree`/`TNode` parameters stay opaque to core — textbook
  Adapter with full type-safety preserved.
- **Strategy dispatch in `applyContentFilter` is correct.** The
  language-adapter-driven content-filter dispatch
  (`content-filter-dispatch.ts:37-53`) routes strip requests to the
  right adapter purely on file extension. No conditional pyramid, no
  per-language branches in fitness — adapters are looked up, dispatched
  to, and nothing else.
- **Layering rules are honoured.** lang-* packs import only from
  `@opensip-tools/core`; none reach into fitness, simulation, graph, or
  each other. The C-family scanners in core are the right shared layer
  (F13).
- **`MinimalTextTree` Bridge handles the MVP→tree-sitter migration
  cleanly.** Four packs delegate to one factory; each can grow real AST
  parse independently without changing the contract (F12).
- **First-writer-wins duplicate policy in `LanguageRegistry` is well
  documented and consistent with `ToolRegistry`.** Aliases and
  extensions are indexed alongside the canonical id with structured
  warnings on collision (`registry.ts:25-91`).
- **Identifier-boundary anchoring in lang-cpp's prefix matchers is
  load-bearing and well-tested.** `matchStringPrefix` /
  `matchCharLiteralPrefix` defend against `abcL"foo"` and similar
  identifier collisions; tests at
  `lang-cpp/__tests__/adapter.test.ts:100-122` lock in the behaviour.

## Notes

- Several findings (F1, F2, F8, F14) cluster around lang-typescript
  being further along than the other packs in both feature surface and
  accreted history. A "lang-typescript v2" pass that ports the package
  to look like the other five (barrel-only imports, single ts
  re-export, no unused subpath exports, no orphaned `query`) would
  retire most of them in one PR.
- F4, F15, and F16 are all "contract declared, not used / not wired" —
  a brief sweep of the `LanguageAdapter` interface and the plugin-
  loader path to delete the unused affordances would be cheap and
  uniformly improve the contract's honesty.
- F3, F10, F11 are the same shape on the parse/strip primitives:
  declared variance ignored, defaults that don't match reality, helpers
  duplicated. They argue for one common pass to normalise the strip
  layer across packs while the deltas are still small.
- The strip-utils audit comments throughout `strip-utils.ts` (region-
  bound advance invariants, branch-ordering load-bearing warnings) are
  high-quality — when scanners get more language consumers, that
  documentation density will be the moat. Recommend keeping the level.
