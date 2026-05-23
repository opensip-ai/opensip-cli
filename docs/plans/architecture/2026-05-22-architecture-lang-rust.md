---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-rust"
package: "@opensip-tools/lang-rust"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-rust

## Summary

`@opensip-tools/lang-rust` is a small, well-bounded MVP language adapter
(four source files, ~270 LOC). It correctly implements the
`LanguageAdapter` contract from
`packages/core/src/languages/adapter.ts`: stable `id`, `fileExtensions`,
`aliases`, a `parse()` that returns a minimal text-tree
(`source` / `filePath` / `lineStarts`), and hand-written
`stripStrings` / `stripComments` lexers that preserve byte length.

Adapter and `parse.ts` shapes are byte-for-byte identical to lang-go,
lang-python, lang-java, and lang-cpp — the per-language pack family is
strikingly consistent at the contract surface. The "tree-sitter
integration deferred" note is captured cleanly: it lives in a single
file-header docstring (`parse.ts`), the `query` field is simply omitted
(matching the optional contract), and there is no `throw new Error('not
implemented')`-style leakage anywhere. No fitness check today reads
`adapter.query`, so the omission is presently harmless.

The two substantive findings sit in `strip.ts`: a privately-duplicated
`scanRegularString` that should be replaced by the shared core helper
(possibly with a small core extension), and the "char vs lifetime"
heuristic which is correct for canonical Rust but has a soft edge case.
A handful of smaller observations follow — most are deliberate trade-offs
worth recording rather than fixing.

## Existing patterns (correct usage)

- **`LanguageAdapter` contract is satisfied idiomatically.**
  `adapter.ts` is a thin object literal; the `parse` /
  `stripStrings` / `stripComments` arrows are direct references to
  the named exports from `parse.ts` and `strip.ts`. No extra interface
  surface, no surprise globals.
  - File: `packages/languages/lang-rust/src/adapter.ts:1-17`

- **`adapters` plugin contract is exported alongside the singleton.**
  Same shape as lang-go / lang-python / lang-java / lang-cpp:
  `export const adapters = [rustAdapter] as const`. The lang-plugin
  loader can ingest this without reflection.
  - File: `packages/languages/lang-rust/src/adapter.ts:17`

- **`parse.ts` reuses `buildLineStarts` from core.**
  Avoids a duplicated UTF-16-correct line-offset implementation; matches
  lang-go / lang-python / lang-java / lang-cpp byte-for-byte.
  - Files:
    - `packages/languages/lang-rust/src/parse.ts:14`
    - `packages/core/src/languages/strip-utils.ts:116-126`

- **Strip routines preserve byte length.** Both `stripStrings` and
  `stripComments` go through `applyRegions` from core, which replaces
  characters with spaces while keeping `\n` intact. This is a load-bearing
  invariant for any check that reports `{line, column}` from a stripped
  buffer — get it wrong and every position offset is silently off.
  - Files: `packages/languages/lang-rust/src/strip.ts:13`,
    `packages/core/src/languages/strip-utils.ts:98-108`

- **Doc-comment variants are handled correctly by accident-of-syntax.**
  Rust's `///`, `//!`, `/** … */`, and `/*! … */` all start with `//`
  or `/*` and so fall through the existing line- and block-comment
  branches. Length-preservation works the same way as code comments.
  No special-casing required at the strip layer.
  - File: `packages/languages/lang-rust/src/strip.ts:32-58`

- **Nested block comments are handled correctly** with a depth counter
  — a Rust-specific rule that lang-go and lang-cpp explicitly do NOT
  apply (their block comments don't nest). The divergence is intentional
  and documented in the file-header.
  - File: `packages/languages/lang-rust/src/strip.ts:41-58`

- **Test coverage targets the state-machine seams.**
  `strip.test.ts` is an explicitly-targeted edge-case suite (unterminated
  literals, `r`-ambiguity, char-vs-lifetime, `\x##` / `\u{…}` escapes).
  It is the most thorough of the per-language strip suites.
  - File: `packages/languages/lang-rust/src/__tests__/strip.test.ts`

## Findings

### Privately-duplicated `scanRegularString` should be replaced by the core helper

- **Files / code:**
  - `packages/languages/lang-rust/src/strip.ts:170-198` — local copy
    of `scanRegularString`, exclusively used inside `strip.ts`.
  - `packages/core/src/languages/strip-utils.ts:65-88` — exported
    `scanRegularString`, already used by lang-go (`strip.ts:12`),
    lang-cpp (`strip.ts:9`), lang-java (`strip.ts:14`).
- **Pattern / principle:** DRY across peer adapters; keep
  language-agnostic primitives in core. The file-header in
  `strip-utils.ts` (lines 5-35) explicitly identifies this helper as
  the cross-language piece that should live in core.
- **Status:** Active drift. lang-rust is the only adapter that does
  not import the shared helper; every other peer that needs a
  double-quoted scanner uses it.
- **Why it matters:**
  1. Maintenance: a future fix to escape handling has to be applied in
     two places, and divergence will go undetected.
  2. The local Rust copy contains an elaborated escape branch for
     `\x##` and `\u{…}`. Tracing through both implementations on the
     existing test inputs shows the elaboration is functionally
     redundant: the simpler "advance 2 on `\`" rule in core's helper
     skips `\u` (or `\x`) and then ordinarily steps over the brace /
     hex digits because none of them is `"` or `\`. The two
     scanners produce the same `contentEnd` for every escape sequence
     the test suite covers.
  3. The one *real* behavioral difference is multi-line support:
     core's `scanRegularString` returns at unescaped `\n` (Go-style
     interpreted-string semantics), while Rust regular strings may
     span lines literally (covered by the
     `'preserves newlines inside multi-line strings'` test in
     `adapter.test.ts:67-73`). This is a genuine gap in core's helper
     for Rust's needs.
- **Recommendation:** Extend core's `scanRegularString` with a single
  `{ allowMultiline?: boolean }` option (default `false` to preserve
  existing call-site behavior), or add a sibling
  `scanMultilineRegularString` helper. Then have `lang-rust/strip.ts`
  drop its local copy and import the shared one. Keep the test cases
  in `strip.test.ts` — they exercise the same paths through the
  unified helper.

### Char-vs-lifetime heuristic has a soft edge case worth documenting

- **Files / code:** `packages/languages/lang-rust/src/strip.ts:120-156`
- **Pattern / principle:** A tokenizer that uses a fixed look-ahead
  window (here: 8 chars) is a heuristic, not a proof — and a heuristic
  belongs in a code comment that says "this is approximate."
- **Status:** Working as intended for canonical Rust; no test failures
  observed.
- **Why it matters:** The 8-char window correctly handles every
  realistic char literal (`'a'`, `'\n'`, `'\\'`, `'\''`,
  `'\u{1F600}'` is 10 chars and falls back to the
  lifetime branch — which happens to be safe because `\u{1F600}` is
  not a Rust source token that the outer scanner needs to recognize
  specially). The branch order also assumes that lifetimes don't have
  escape sequences (correct: `'a`, `'static`, `'_`). However:
  1. The fallback when no closing quote is found inside the window is
     to advance only 1 character (treat as a lifetime). Path-of-no-harm
     for current Rust, but it's a comment-free heuristic and a future
     reader will have to redo the analysis. A single docstring above
     the branch — "8 chars covers every char literal in
     stable Rust as of edition 2021; longer lifetimes (`'a_very_long`)
     are also safe because we just step past the apostrophe" — would
     pay for itself the next time anyone touches this code.
  2. The test
     `'treats trailing apostrophe at EOF as a lifetime-style token'`
     (`strip.test.ts:88-93`) exercises the EOF branch but doesn't
     pin down the semantic — it asserts only that length is preserved.
     A second assertion that `out` equals `src` would document the
     "treat as lifetime" decision.
- **Recommendation:** Add a one-line comment above the look-ahead
  branch explaining the 8-char window and the lifetime-fallback
  decision. Optionally tighten the EOF test to assert `out === src`.
  No code change required.

### `parse()` cannot fail today; the `null` return path is unreachable

- **Files / code:** `packages/languages/lang-rust/src/parse.ts:22-28`
- **Pattern / principle:** Contract-completeness — the
  `LanguageAdapter.parse()` signature is `TTree | null` because
  parsers can fail (tree-sitter init error, invalid UTF-8, etc.). A
  text-only adapter never fails, so the `null` is dead code today.
- **Status:** Cosmetic; identical pattern in lang-go / lang-python /
  lang-java / lang-cpp.
- **Why it matters:** When tree-sitter integration lands, the adapter
  WILL need to return `null` on parse failure, and any consumer that
  doesn't currently handle `null` will start mis-handling Rust files
  silently. The risk is in *consumer* code, not here. But it's worth
  flagging as a known-future-behavior in the file-header so the
  tree-sitter migration doesn't surprise downstream check authors.
- **Recommendation:** Extend the existing file-header in `parse.ts`
  with a one-line note: "MVP text-tree never returns null; the
  tree-sitter migration will introduce real failure paths — consumers
  that destructure `tree.source` directly today should be prepared to
  handle null." No code change required.

### `RustTree` shape duplicates an unwritten `MinimalTextTree` core type

- **Files / code:**
  - `packages/languages/lang-rust/src/parse.ts:16-20`
  - `packages/languages/lang-go/src/parse.ts:16-20`
  - `packages/languages/lang-python/src/parse.ts:16-20`
  - `packages/languages/lang-java/src/parse.ts:16-20`
  - `packages/languages/lang-cpp/src/parse.ts` (same)
- **Pattern / principle:** The five MVP text-trees are byte-for-byte
  identical: `{ source: string; filePath: string; lineStarts:
  readonly number[] }`. That is a candidate for a single core
  interface (`MinimalTextTree` or similar) with each pack exporting a
  branded alias.
- **Status:** Mild drift-prone duplication; not currently causing
  problems because no consumer destructures the tree shape.
- **Why it matters:** When tree-sitter ships for one language but not
  the others, the shape diverges in a documented way — but for the
  MVP era, having five identical interfaces is an invitation to
  someone "improving" one of them and silently de-syncing the family.
  A shared core type makes the divergence point explicit at the type
  system level.
- **Recommendation:** Add `MinimalTextTree` to
  `@opensip-tools/core/languages` and have each MVP pack export a
  branded type:
  ```ts
  // core
  export interface MinimalTextTree {
    readonly source: string
    readonly filePath: string
    readonly lineStarts: readonly number[]
  }
  // lang-rust
  export type RustTree = MinimalTextTree & { readonly _tag: 'RustTree' }
  ```
  The brand keeps `LanguageAdapter<RustTree>` distinct from
  `LanguageAdapter<GoTree>` while sharing the structural definition.
  Defer this until at least one adapter starts diverging — premature
  consolidation has a tax of its own.

### Public surface area in `index.ts` is wider than needed

- **Files / code:** `packages/languages/lang-rust/src/index.ts:1-3`
- **Pattern / principle:** Each `export` from a package barrel is a
  semver-stable surface. A symbol that nothing outside the package
  imports is a long-term liability — every future refactor has to
  preserve its name and shape.
- **Status:** Same shape as the other peer packs. Three of the
  exports — `parseRust`, `RustTree`, `stripStrings`,
  `stripComments` — are not consumed anywhere outside this package
  (only `rustAdapter` and `adapters` are referenced externally; see
  `grep RustTree`).
- **Why it matters:** Plugin contract is "export `adapters`" — the
  rest is a convenience surface intended for tests inside the package
  and for power users. The package.json `exports` map already
  surfaces `./parse` and `./strip` as subpaths, which is the supported
  way to consume internals; re-exporting the same names from the
  barrel is double the surface for the same value.
- **Recommendation:** Consider trimming the barrel to
  `{ rustAdapter, adapters, type RustTree }`. Rationale:
  `RustTree` keeps the type useful for external `LanguageAdapter`
  generic parameter usage; the strip/parse functions remain reachable
  through the subpath exports for power users. This is a
  semver-affecting change, so defer to a major release. (Same applies
  to lang-go / lang-python / lang-java / lang-cpp barrels — handle as
  a family if at all.)

### Disabled `sonarjs/cognitive-complexity` rule should reference the core extension plan

- **Files / code:** `packages/languages/lang-rust/src/strip.ts:20`,
  `strip.ts:169`
- **Pattern / principle:** ESLint disable comments work best when the
  reason is durable. "Cyclomatic complexity is inherent to lexer-style
  scanners" is a reasonable defense, but it's also the kind of
  defense you'd reach for when the actual fix is to split the function
  — which is exactly the recommendation in the first finding above.
- **Status:** Cosmetic.
- **Why it matters:** Once `scanRegularString` moves to core (see
  finding 1) the local function shrinks and one of the two suppressions
  becomes unnecessary. The remaining `scan` function suppression stays
  defensible.
- **Recommendation:** When making the move recommended in finding 1,
  drop the suppression on the now-deleted local helper. Leave the
  suppression on `scan` with the existing rationale.

## Non-findings considered and dismissed

- **"`stripStrings` / `stripComments` should live in core."** Rejected.
  The string and comment *grammars* are language-specific (raw strings
  with hash counters, byte-string prefixes, doc-comment variants,
  nested vs non-nested block comments). The cross-language pieces
  already live in core (`Region`, `applyRegions`,
  `scanRegularString`, `buildLineStarts`); the per-language lexer
  state-machine is correctly local.

- **"The `scope: ['rust']` aliasing should be in core."** Rejected.
  Each adapter declares its own `id` + `aliases`. The matching logic
  (set intersection of check scope and adapter id/alias) lives in the
  fitness engine target-resolution path, which is the correct layer.

- **"Doc comments (`///`, `//!`) should be reported separately from
  code comments."** Rejected for now. `stripComments` is defined to
  remove all comments uniformly. A future check that wants to
  introspect doc comments specifically should query the tree-sitter
  AST when it lands, not pattern-match the stripped text.

- **"Char literal heuristic should use a parser instead of a
  fixed-width window."** Rejected. The 8-char window covers every
  legal char literal in stable Rust including `'\u{XXXXXX}'`
  (10 chars triggers the lifetime fallback, which is correctly
  conservative — no `\u` lifetime exists). Replacing the heuristic
  with a real parser is the tree-sitter migration; not worth doing
  twice.

- **"`parse()` could memoize on `(filePath, contentHash)`."**
  Rejected. The core parse-cache layer
  (`packages/core/src/languages/parse-cache.ts`) handles caching at
  the engine level; doing it again in the adapter would be either
  redundant or double-keyed. The adapter is correct to be pure.

- **"`adapters` should be `Object.freeze`d."** Rejected. The `as const`
  on the array literal already gives readonly tuple type-checking. A
  freeze would be runtime defense for consumers reaching past the type
  system, which is out of scope.

- **"The package should depend on `tree-sitter` even if unused, for
  future-proofing."** Rejected. Adding an unused production
  dependency is a real cost (install size, supply-chain surface,
  publish-time vulnerability tracking). When tree-sitter integration
  starts, add the dep then.
