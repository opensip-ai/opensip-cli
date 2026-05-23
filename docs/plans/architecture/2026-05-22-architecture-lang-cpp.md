---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-cpp"
package: "@opensip-tools/lang-cpp"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-cpp

## Summary

`@opensip-tools/lang-cpp` is a small adapter (`adapter.ts`, `strip.ts`,
~150 LOC of scanner) that conforms to the `LanguageAdapter` contract.
It deliberately punts AST-level analysis (`parse: () => null`) and ships
clang-tidy-driven checks via the `CommandConfig` pattern in
`@opensip-tools/checks-cpp`. Strip routines are a hand-written
state-machine lexer that recognizes line/block comments, regular
strings with the four C/C++ encoding prefixes (`u8`, `u`, `U`, `L`),
raw strings with delimiters and the same prefixes (plus `R`), and
char literals.

The adapter is **layer-clean**: imports only `@opensip-tools/core` types
and helpers (`Region`, `applyRegions`, `scanRegularString`); no
sideways dependencies. The strip code is comparable in shape to
lang-java/lang-go/lang-rust strip files but predates any extracted
C-family helper, so the lexer body is duplicated four ways.

The biggest substantive issues are:

1. The adapter advertises `aliases: ['c', 'c++']` but the platform's
   alias-matching only covers a single warning path, not check-to-target
   resolution — so a target written with `languages: ['c']` silently
   matches no `cpp`-scoped checks.
2. One adapter folds C and C++ together with no way for a check or a
   target to scope to one language without the other.
3. Line continuations (`\<newline>`) are not honored, breaking `//`
   comments and char/string literals that span lines via line splicing.
4. Across lang-cpp / lang-java / lang-go, the line-comment, non-nesting
   block-comment, and char-literal scanners are byte-identical
   modulo prefixes — a `scanLineComment` / `scanBlockCommentNonNesting`
   pair belongs in `core/languages/strip-utils.ts`.

## Existing patterns (correct usage)

- **Layered imports.** `adapter.ts` imports `LanguageAdapter` from the
  core subpath; `strip.ts` imports `applyRegions`, `scanRegularString`,
  `Region` from the core barrel. No imports from cli, contracts, peer
  language packs, or check packs. Matches the layering rules in
  CLAUDE.md.
- **Region-overlay strip pattern.** Both `stripStrings` and
  `stripComments` go through the shared `Region[]` + `applyRegions`
  primitive, preserving byte length and newlines. Identical contract to
  the other lang-* packs, so downstream checks get consistent
  positional reporting.
- **`adapters` plugin barrel.** `index.ts` re-exports
  `cppAdapter, adapters` matching the lang plugin contract used by
  `discoverToolPackages` / the lang plugin loader (`packages/fitness/engine/src/plugins/loader.ts`
  duck-types `id`, `fileExtensions`, `parse`, `stripStrings`,
  `stripComments`).
- **Honest punt on parse.** `parse: () => null` plus a comment that
  explains C/C++ uses clang-tidy via the `CommandConfig` pattern is
  exactly the right move — far better than shipping a fake or
  half-working tree-sitter parser. The `LanguageRegistry` happily holds
  parse-less adapters (registry doesn't require `parse` to return
  non-null).
- **Length-preserving strip with newline preservation** (verified by
  test case at `__tests__/adapter.test.ts:59-64`). This is what every
  text/regex check downstream depends on for accurate line/column
  reporting.

## Findings

### Aliases are advertised but only used for a warning path, not for matching
- **Files / code:**
  - `packages/languages/lang-cpp/src/adapter.ts:17` —
    `aliases: ['c', 'c++']`
  - `packages/fitness/engine/src/cli/fit.ts:384` — only consumer of
    `adapter.aliases`, used for the "known languages" warning set
  - `packages/fitness/engine/src/targets/target-registry.ts:80-99`
    (`findByScope`) — pure `Array.includes` between
    `scope.languages` and `target.config.languages`; aliases are not
    normalized
- **Pattern / principle:** Single source of truth; least surprise.
  Public API surface should mean what it looks like it means.
- **Status:** ARCHITECTURAL TRAP.
- **Why it matters:** A user reading the adapter source sees
  `aliases: ['c', 'c++']` and reasonably writes
  `languages: ['c']` in `opensip-tools.config.yml`. Validation passes
  (the language is "known"). Scope matching silently fails — no error,
  no warning, no checks run on `.c` files for `cpp`-scoped checks. The
  warning path covers acceptance but not behavior, which is the worst
  combination.
- **Recommendation:** Either (a) make `findByScope` (and
  `define-check`'s scope intake) alias-aware by canonicalizing scope
  language strings through the language registry before comparison, or
  (b) drop the `aliases` field on `cppAdapter` and document that
  `cpp` is the only acceptable scope language. (a) is the better fix
  because lang-rust ships `aliases: ['rs']` and lang-go ships
  `aliases: ['golang']` — same trap, broader surface. The work belongs
  in `core/languages/registry.ts` (a `canonicalize(id)` helper) and
  `target-registry.ts#findByScope`.

### One adapter folds C and C++ together with no plausible path to separation
- **Files / code:**
  - `packages/languages/lang-cpp/src/adapter.ts:14-21` —
    `id: 'cpp'`, `fileExtensions` covers `.c`, `.cpp`, `.cc`, `.cxx`,
    `.c++`, `.h`, `.hpp`, `.hh`, `.hxx`
  - `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:52`
    — sole `cpp`-scoped check declares `scope: { languages: ['cpp'] }`
- **Pattern / principle:** Adapter granularity should match the
  granularity of decisions checks need to make. Single Responsibility
  at the package boundary.
- **Status:** PLATFORM ARCHITECTURE TENSION.
- **Why it matters:** C and C++ are different languages with
  different lint rules (clang-tidy presets are language-specific —
  `cppcoreguidelines-*` is meaningless on a `.c` file). `.h` is
  ambiguous — could be C or C++. Today the platform has no way to say
  "scope this check to C only" or "scope this check to C++ headers
  only"; the only option is `cpp`. As checks-cpp grows beyond the
  passthrough, this collapses information. The `aliases: ['c', 'c++']`
  hint in the source suggests the author saw this coming and didn't
  resolve it.
- **Recommendation:** Defer until checks-cpp gains a second check.
  When that happens, the cleanest move is to split into two adapters
  (`cAdapter` with `.c`, `.h`; `cppAdapter` with the rest) sharing a
  `strip.ts` module. The `.h` ambiguity can be resolved by a
  per-target hint or by content-sniffing the first non-comment token.
  Recording the constraint here so the next contributor doesn't widen
  the trap by adding more `cpp`-scoped checks that are silently wrong
  on `.c` inputs.

### Preprocessor and line-continuation handling are absent
- **Files / code:**
  - `packages/languages/lang-cpp/src/strip.ts:27-34` — line-comment
    scanner stops at `\n` with no check for `\\<newline>` (line splice)
  - `packages/languages/lang-cpp/src/strip.ts:96-117` — char-literal
    scanner uses `maxScan = startQuote + 8` and does not recognize line
    splices either
  - No `#`-prefixed handling anywhere in the file
- **Pattern / principle:** Correctness of strip primitives — they
  underpin every regex/text check on `.c`/`.cpp` files.
- **Status:** GAP, low-frequency in modern code but real.
- **Why it matters:** In C and C++, a backslash followed by a newline
  is removed by translation phase 2 — meaning `// comment\<newline>`
  continues on the next line, and string/char literals can be spliced
  across lines. Today, lang-cpp's `//` scanner stops at the first `\n`,
  and a check searching for a banned identifier just past a spliced
  comment line will see source it shouldn't see. Macro definitions in
  headers (`#define FOO \<nl> bar`) are similar. Empirically rare in
  modern code, but rare-and-silent is the worst failure mode for a
  strip primitive. There is also no preprocessor awareness — `#if 0
  ... #endif` blocks remain visible to text-based checks, and string
  prefixes inside `#define` bodies are scanned as code.
- **Recommendation:** Two-line fix for line-continuation in `//` —
  treat `src[i] === '\\' && src[i+1] === '\n'` as continuation inside
  the line-comment loop. Add a regression test pair (spliced comment,
  spliced macro). Preprocessor masking is a larger discussion: the
  existing answer ("regex/text checks on C/C++ are best-effort, real
  analysis is via clang-tidy") is defensible — but it should be
  documented in the adapter file's leading comment so users know what
  they're getting.

### Scanner duplication across lang-cpp / lang-java / lang-go
- **Files / code:**
  - `packages/languages/lang-cpp/src/strip.ts:27-49` — line and
    non-nesting block comment scanners
  - `packages/languages/lang-java/src/strip.ts:32-54` — byte-identical
    line and non-nesting block comment scanners
  - `packages/languages/lang-go/src/strip.ts:30-52` — byte-identical
    line and non-nesting block comment scanners
  - Char-literal scanners across the three packs differ only in maxScan
    bounds and which prefix chars open them
- **Pattern / principle:** DRY at the kernel; the layering rules in
  CLAUDE.md explicitly point shared lexer concerns at
  `core/languages/strip-utils.ts`.
- **Status:** REFACTOR OPPORTUNITY.
- **Why it matters:** The kernel already extracted
  `scanRegularString`, `applyRegions`, `Region`, `buildLineStarts` to
  `core/strip-utils.ts` — exactly because they were pasted into every
  pack. Line comments and non-nesting block comments are the next two
  obvious extractions. Today, a fix to (e.g.) line-continuation
  handling needs to land in three or four places. Lang-rust's nesting
  block comment is the only meaningful variation.
- **Recommendation:** Add `scanLineComment(src, start)` and
  `scanBlockCommentNonNesting(src, start)` to
  `core/src/languages/strip-utils.ts` returning `{ end: number }`, and
  call them from lang-cpp, lang-java, lang-go. Keep lang-rust's nested
  block scanner local. Char-literal scanners are slightly more
  divergent (Rust's lifetime ambiguity, char prefixes) but a
  parameterized `scanCharLiteral({ openChars, maxScan })` is a
  follow-up worth considering.

### `u8` char prefix and unbounded char-literal scan
- **Files / code:**
  - `packages/languages/lang-cpp/src/strip.ts:98-117` — char-literal
    detection and `maxScan = Math.min(startQuote + 8, len)`
- **Pattern / principle:** Correctness of token recognition.
- **Status:** MINOR GAP.
- **Why it matters:** C++17 added `u8'a'` — the scanner does not list
  `u8'` in its opener set, so `u8'a'` is reached via the regular-string
  branch (which checks `matchStringPrefix(src, i) > 0` then `src[i+2]`
  for `"`); when that fails, the loop falls through to `i++` and a
  later iteration may treat `'a'` as a standalone char literal. That
  works by accident. More tangibly, the `maxScan + 8` bound means
  `'\u{1F600}'` (universal-character-name escape, C++23 named UCNs) or
  a multi-character literal `'abcd'` (well-defined as `int` in C/C++)
  can run past the bound, fall to `i++`, and the `'` at the start gets
  treated literally. Probably fine in practice; not theoretically
  sound.
- **Recommendation:** Add `u8'` to the char-literal opener set, and
  remove the maxScan cap — replicate the bounded-by-newline pattern
  used in lang-java/lang-go (stop at unescaped `'` or unescaped `\n`).
  The 8-char heuristic predates `scanRegularString` and isn't carrying
  its weight here.

### `parse: () => null` is correct but the contract should make this explicit
- **Files / code:**
  - `packages/core/src/languages/adapter.ts:29` — JSDoc says `parse`
    "Returns null on parse failure"
  - `packages/languages/lang-cpp/src/adapter.ts:7-13,18` — comment
    says `parse() returns null intentionally`
- **Pattern / principle:** Interface segregation. The contract should
  distinguish "I tried and failed" from "I do not parse."
- **Status:** API SMELL, low priority.
- **Why it matters:** Today the parse-cache and the cross-language
  query layer treat `null` from `parse()` as an error condition. The
  cpp adapter returns `null` unconditionally — by design. That's
  indistinguishable to callers from a malformed input. Anything that
  later wants to ask "is this language AST-queryable?" has to know
  out-of-band. It also leaves a small footgun for someone adding an
  AST-using cpp check: it'll silently skip every file.
- **Recommendation:** Either declare a sentinel (e.g. an
  `ASTLessAdapter` subtype with `parse?: never`) or add an explicit
  capability flag (`readonly parsesAST?: boolean`). The cleaner answer
  is to make `parse` optional on the interface — `parse?(content,
  filePath): TTree | null` — and have the parse-cache and any AST
  consumer check `adapter.parse` before calling. The lang-cpp adapter
  then drops the `parse: () => null` line entirely. This also benefits
  any future "shell-only" adapter that wants to expose stripStrings
  but no parser.

## Non-findings considered and dismissed

- **"Nine extensions hardcoded in an array — primitive obsession?"**
  No. The list is the language definition; abstracting it would not
  remove duplication or improve cohesion. The registry indexes by
  extension; a `Set`-based lookup would be marginally faster but is
  not a real concern at the registry's scale.
- **"`scan()`'s cognitive complexity warrants a refactor."** No. The
  ESLint suppression comment at line 16 is correct — token-state
  machines have inherent complexity and splitting them by token type
  hurts readability and reasoning. The shape matches lang-java and
  lang-go. The comment-extraction recommendation above is a more
  targeted improvement.
- **"Raw-string `R` prefix without context fires too eagerly."** Looked
  at this. `matchRawStringPrefix` returns 1 for any `R` and only
  commits to raw-string scanning if `src[i+1] === '"'` — for a token
  like `Roger` we fall through after one byte advance with no harm. Not
  a bug.
- **"`matchStringPrefix` is called twice on the regular-string branch
  (line 86 and 87)."** Cosmetic micro-redundancy; cost is two byte
  reads per matched call site. Not worth a finding.
- **"Block-comment scanner does not record an unterminated block."**
  When the inner loop runs to EOF, `commentRegions.push({ start, end:
  i })` still executes with `end === len`. Behavior is correct
  (everything from `/*` to EOF is masked).
- **"Length preservation."** Verified by test
  (`__tests__/adapter.test.ts`); `applyRegions` only writes spaces and
  preserves `\n`. No issue.
- **"Should the cpp adapter import `lang-typescript`'s `filterContent`
  for compatibility?"** No — that documented exception (D14 in
  CLAUDE.md) exists only for lang-typescript itself. Lang-cpp routes
  through the kernel's `scanRegularString` correctly.
