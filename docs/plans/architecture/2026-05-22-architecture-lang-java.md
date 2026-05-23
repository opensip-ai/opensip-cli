---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-java"
package: "@opensip-tools/lang-java"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-java

## Summary

`@opensip-tools/lang-java` is a small, well-shaped MVP language adapter
(four files: `index.ts`, `adapter.ts`, `parse.ts`, `strip.ts`). It
satisfies the `LanguageAdapter<TTree>` contract from
`@opensip-tools/core/languages/adapter.js` cleanly and reuses the right
shared primitives from core (`applyRegions`, `scanRegularString`,
`Region`, `buildLineStarts`). The `parseJava` shim is a transitional
"hold a line-starts table until tree-sitter lands" implementation and
mirrors `lang-go` / `lang-rust` byte-for-byte — that's the package's
biggest architectural smell: the C-family lang packs have crystallised
~50 lines of near-identical lexer scaffolding, and the Java strip is one
of four near-twins.

The Java-specific surface (text blocks, char literals) is mostly
correct, but two correctness gaps deserve attention:
1. Text-block scanning ignores backslash escapes, so `\"""` inside a
   text block will incorrectly close the block.
2. Char-literal scanning is unbounded — only `\n` or `'` stops it,
   while `lang-cpp` and `lang-rust` cap at ~8 characters to defend
   against unterminated/malformed literals.

The package has no findings against SOLID; the issues are duplication
(DRY) and two language-spec edge cases.

## Existing patterns (correct usage)

- **Layering is clean.** The package depends on `@opensip-tools/core`
  only (per `package.json`), uses the public core barrel for the
  helpers it needs, and the typed import of `LanguageAdapter` from
  `@opensip-tools/core/languages/adapter.js` (one of the documented
  subpath exceptions). It does not import from `fitness`, `cli`,
  `contracts`, or any peer language pack — so dependency-cruiser's
  layering rule is satisfied.
- **Region-overlay is reused, not re-implemented.** `strip.ts` builds
  `Region[]` and hands them to the shared `applyRegions` from core
  rather than open-coding length-preserving replacement.
- **Regular-string scanner is reused.** The `"..."` case delegates to
  `scanRegularString` (core) rather than re-implementing escape /
  newline handling. Compare `lang-rust`, which inlines its own
  `scanRegularString` because it has Rust-specific `\u{...}` and `\x##`
  escape semantics — Java doesn't need them, so the core helper is
  exactly right.
- **Adapter shape mirrors peers.** `adapter.ts` is the same minimal
  descriptor used by `lang-go`, `lang-rust`, `lang-cpp`: `id`,
  `fileExtensions`, `parse`, `stripStrings`, `stripComments`, plus the
  `adapters` plugin-contract array. Adding tree-sitter later requires
  only growing `JavaTree`; the contract is unchanged.
- **Length-preserving stripping invariant is maintained.** Every region
  the scanner emits is byte-aligned to the source, and the unit tests
  assert `out.length === src.length` for every transformation.
- **`@fileoverview` comment in `parse.ts` documents the MVP-vs-future
  trade-off** so a future contributor can see why `parseJava` is a
  shim, not a parser. This is the right amount of context.

## Findings

### F1: Text-block scanner does not honor `\"` and `\\` escapes

- **Files / code:**
  `packages/languages/lang-java/src/strip.ts:60-88` — text-block branch.
- **Pattern / principle:** Correctness against language spec
  (JLS §3.10.6).
- **Status:** Bug — minor but real.
- **Why it matters:** Java text blocks honor the same escape sequences
  as regular string literals, including `\"` (escaped double quote) and
  `\\` (escaped backslash). The current closer scan walks the body
  byte-by-byte:
  ```ts
  while (j < len) {
    if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') {
      // close
    }
    j++
  }
  ```
  with no escape tracking. A body containing `\"""` (escaped quote
  followed by two literal quotes) is legal Java — the `\"` consumes one
  quote, leaving only two — but this scanner sees three consecutive `"`
  bytes and closes the block prematurely, mis-classifying the rest of
  the file as code. Likewise `\\\"\"\"` is closing-prevented in
  combinations the spec considers valid. The bug is cosmetic for almost
  every real-world text block, but it can produce silent
  mis-classification in adversarial or unusual sources, leading to
  wrong-line-number violations downstream.
- **Recommendation:** Track an `escape` flag in the body scan, mirroring
  the regular-string scanner. The fix is ~3 lines:
  ```ts
  let escape = false
  while (j < len) {
    if (escape) { escape = false; j++; continue }
    if (src[j] === '\\') { escape = true; j++; continue }
    if (src[j] === '"' && src[j+1] === '"' && src[j+2] === '"') { /* close */ }
    j++
  }
  ```
  Add unit coverage for `"""\n a \\\" \"\"\" """` and `"""\n \\\\ """`.

### F2: Char-literal scan is unbounded — diverges from peer adapters

- **Files / code:**
  `packages/languages/lang-java/src/strip.ts:99-126`.
- **Pattern / principle:** Defensive lexing; consistency with sibling
  C-family adapters.
- **Status:** Latent bug — only triggers on malformed input.
- **Why it matters:** The char-literal scanner stops on `'` or
  unescaped `\n`. There is no upper bound on how far the loop will
  scan. If a source file contains a stray apostrophe (e.g. inside a
  region the adapter has already mis-classified, or in genuinely
  malformed code), the scanner will eat everything up to the next `'`
  or newline and treat that span as a single char literal — meaning
  any embedded `"` or `//` won't be recognised as a string or comment.
  `lang-cpp` defends against this with `const maxScan = Math.min(startQuote + 8, len);`
  and `lang-rust` uses the same 8-character heuristic to disambiguate
  char-literal from lifetime. A Java char literal is at most one
  unicode escape (e.g. `'A'` = 8 chars including quotes), so an
  identical bound is appropriate.
- **Recommendation:** Cap the scan at `Math.min(i + 8, len)` to match
  `lang-cpp` / `lang-rust` semantics, and on overflow advance `i` by
  one (treating the apostrophe as code) rather than committing the
  whole consumed run as a "char literal". This both improves robustness
  and removes one more divergence from the C-family scanner family.

### F3: Lexer scaffolding is duplicated across four C-family packs

- **Files / code:**
  `packages/languages/lang-java/src/strip.ts`,
  `packages/languages/lang-go/src/strip.ts`,
  `packages/languages/lang-cpp/src/strip.ts`,
  `packages/languages/lang-rust/src/strip.ts`.
- **Pattern / principle:** DRY; "rule of three+1" — when four packs
  carry the same code with the same eslint-disable comment, it's time
  to extract.
- **Status:** Established duplication, growing.
- **Why it matters:** The line-comment scan (`'/' '/'` to `\n`),
  non-nesting block-comment scan (`'/' '*'` to `'*' '/'`), char-literal
  skip, the `Scan` interface, the
  `// eslint-disable-next-line sonarjs/cognitive-complexity` lint
  exemption, and the `stripStrings` / `stripComments` wrapper functions
  are byte-identical across `lang-java`, `lang-go`, and `lang-cpp`
  (with `lang-rust` differing only in nesting block-comment depth).
  Every future C-family pack (Kotlin, Scala, C#, Swift, Dart, …) will
  copy this same skeleton. A bug fix to the block-comment scan today
  has to land in four packages; F1 (above) is a textbook example —
  Java's text-block scanner has the bug, but a similar
  forward-progress assumption pattern is repeated in raw-string scans
  in the other packs.
- **Recommendation:** Promote a `scanCFamilyComments` (or
  `cFamilyLexerCore`) helper into
  `packages/core/src/languages/strip-utils.ts` that scans `//` and
  `/* */` (with a `nesting: boolean` option for Rust), char literals
  with the 8-char cap, and emits `commentRegions` / advances the
  cursor. Each C-family pack then becomes ~30 lines of language-specific
  prefix handling (text blocks, raw strings, byte strings, encoding
  prefixes) layered on top. Also lift the `Scan` interface and the
  `stripStrings`/`stripComments` wrapper pair into a single
  `defineCFamilyStrip(...)` factory so the wrapper boilerplate
  collapses too. This is a non-blocking refactor but should land before
  the fifth C-family adapter (Kotlin / C# / Swift) does.

### F4: `parse.ts` is byte-identical across `lang-java`, `lang-go`, `lang-rust`

- **Files / code:**
  `packages/languages/lang-java/src/parse.ts`,
  `packages/languages/lang-go/src/parse.ts`,
  `packages/languages/lang-rust/src/parse.ts`.
- **Pattern / principle:** DRY at the kernel boundary.
- **Status:** Three identical files differing only in the exported type
  alias name (`JavaTree` / `GoTree` / `RustTree`).
- **Why it matters:** The MVP "tree" returned by all three packs is
  literally `{ source, filePath, lineStarts }`. The doc-comment is
  copy-pasted with the language name swapped in. When the first
  language gets a real tree-sitter parser, the others won't follow
  immediately — meaning we'll likely keep three parallel placeholders
  for a while. A shared helper would reduce drift risk and make the
  "I want to ship a new placeholder language adapter" path one import
  rather than a copy-paste of the file.
- **Recommendation:** Add a tiny core helper, e.g.
  `createMinimalTree(content, filePath)` returning
  `{ source, filePath, lineStarts: buildLineStarts(content) }`, in
  `@opensip-tools/core/languages`. Each MVP `parseX` becomes a one-line
  wrapper that types the result as `XTree`. Once a pack gets a real
  parser it stops using the helper. This is a low-priority cleanup but
  worth doing alongside F3.

### F5: `parseJava` cannot return `null` — type narrows are dead code

- **Files / code:**
  `packages/languages/lang-java/src/parse.ts:22-28`.
- **Pattern / principle:** Type-shape vs runtime-shape consistency.
- **Status:** Type honesty issue — the contract says
  `parse(...): TTree | null`, the implementation never returns null.
- **Why it matters:** Callers that defensively branch on `tree === null`
  (per the `LanguageAdapter` contract) will dead-branch for Java today,
  but the contract is correct in general (a real Java parser certainly
  could fail on malformed input). This is fine as long as future
  contributors understand "MVP shim never fails; tree-sitter version
  will." The risk is that someone reads the current implementation and
  removes the `| null` from `JavaTree`, then a real parser swap-in
  becomes a breaking type change.
- **Recommendation:** Add a one-line comment on the `return` —
  `// MVP shim cannot fail; real parser may return null on parse error`
  — to anchor the contract. No code change. The same applies to
  `lang-go` and `lang-rust`.

### F6: Char-literal escape branch ordering is correct but subtle — worth a comment

- **Files / code:**
  `packages/languages/lang-java/src/strip.ts:99-126`.
- **Pattern / principle:** Readability of state-machine code.
- **Status:** Minor — works correctly, but the order of the
  `if (escape)` branch placed *before* the `if (ch === "'")` branch is
  load-bearing and not commented.
- **Why it matters:** For `'\''` (escaped apostrophe — one of the most
  common Java char literals), the scanner only terminates correctly
  because the `escape` reset runs before the `'`-as-closer check.
  Reordering these branches — e.g. for "consistency" with the regular
  string case in core — would silently miscompile `'\''` into a
  one-character literal `'\'` followed by `'` as code. The Go scanner
  has the same shape and the same hazard. Compare to `lang-rust` where
  the entire char-literal handling uses a different lookahead approach
  to disambiguate from lifetimes, making the question moot.
- **Recommendation:** Add a one-line comment above the loop noting that
  the escape branch must be evaluated before the closing-quote branch,
  with `'\''` as the canonical example. Considered together with F3:
  if char-literal scanning moves into a shared core helper, this
  comment lands once instead of in four packs.

## Non-findings considered and dismissed

- **Hex / binary numeric literals with `_` separators (Java 7+).** Not
  relevant to string/comment stripping — these literals contain no
  characters that the lexer's outer loop would mistake for a string,
  comment, or char-literal opener. Unlike C++14 (which uses `'` as a
  digit separator and is a real lexer hazard), Java uses `_`.
  `0xFF_FF` and `0b1010_0101` flow through the default `i++`
  fallthrough untouched. No action needed.
- **Char literals confusable with strings.** Java `'…'` is bounded
  (single character, possibly escape-sequence). The current scanner
  handles all escape forms (`'\n'`, `'\t'`, `'\\'`, `'A'`,
  `'\''`) correctly within the unboundedness caveat noted in F2. No
  systemic issue beyond F2.
- **`stripStrings` should also strip text-block delimiters.** The
  current implementation strips only the *body* of a text block, not
  the opening/closing `"""`. That's consistent with how regular-string
  stripping works in this package and across all peer packs (the
  delimiters are preserved as code; only content goes blank). Tests
  assert this behaviour. No change.
- **`adapter.ts` should expose `aliases: ['jvm']` or similar.** Java
  has no widely-used short alias the way Rust uses `rs` or Go uses
  `golang`. The lone `'java'` id is fine; check authors and config
  authors will all spell it the same way.
- **`buildLineStarts` is unused by `strip.ts`.** Correct — strip is
  byte-offset-only and doesn't need the line-starts table. The table
  exists for `parse()`'s consumers. No change.
- **No `query` implementation.** The `LanguageQueryAPI` is optional in
  the `LanguageAdapter` contract; adapters without a real parser
  cannot meaningfully implement `findFunctions` / `findCallsTo` etc.
  Java's MVP correctly omits it, matching `lang-go`, `lang-rust`,
  `lang-cpp`. When tree-sitter-java lands, `query` slots in then.
- **`parseJava`'s line offsets being O(n).** That's the nature of the
  task — `buildLineStarts` is the canonical helper, used by every peer
  adapter, with explicit comments about UTF-16 offset preservation. No
  optimisation needed at MVP scale.
- **`as const` on the `adapters` array.** Same pattern as every peer
  pack; gives the plugin loader a literal type. Correct.
