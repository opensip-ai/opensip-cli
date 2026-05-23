---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-go"
package: "@opensip-tools/lang-go"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-go

## Summary

`@opensip-tools/lang-go` is a small, well-shaped MVP language adapter:
five exports across `index.ts`, `adapter.ts`, `parse.ts`, `strip.ts`, and
a single test file. The structure mirrors `lang-java` exactly (which is
the closest sibling — both are "no AST yet, hand-written
strip + line-starts metadata" adapters); that consistency is a
genuine asset and means the package has zero idiosyncrasies a future
contributor needs to learn.

The Go-specific quirks the strip routine has to handle —
backtick-delimited raw strings (no escapes, can span lines) and Go's
non-nesting block comments — are correctly handled by a hand-rolled
lexer that delegates the regular-string and region-overlay primitives
to `@opensip-tools/core` (`scanRegularString`, `applyRegions`,
`buildLineStarts`). There is no hand-rolled regex; everything is an
index-walk state machine, so Unicode/UTF-16 and multi-line edge cases
behave correctly.

The most substantive findings concern (a) cross-pack duplication of the
shared scanner scaffold between Go/Java/Rust/C++ — which is recognised
in the codebase comments but not yet refactored, (b) a couple of
Go-specific spec corners that aren't asserted by tests, and (c) a
contract drift on the `parse` return type relative to the
`LanguageAdapter` interface contract.

## Existing patterns (correct usage)

- **`LanguageAdapter` contract conformance.** `goAdapter` declares
  `id`, `fileExtensions`, `aliases`, `parse`, `stripStrings`, and
  `stripComments` — all required surface, plus the `aliases: ['golang']`
  hook that the contract documents as optional. No `query` or
  `warmup` are advertised, which is correct for an MVP.
- **Plugin contract.** `adapters = [goAdapter] as const` is exported
  from both `adapter.ts` and re-exported via `index.ts` — matching the
  shape `lang-java`, `lang-rust`, `lang-cpp`, and `lang-python` use.
- **Layering.** Imports flow `lang-go → core` only. There is no leak to
  `cli`, `contracts`, `fitness`, `simulation`, or sibling lang packs,
  which is exactly what `.dependency-cruiser.cjs` enforces.
- **Length-preserving strip.** Both `stripStrings` and `stripComments`
  delegate to `applyRegions`, which spaces over the marked regions
  while preserving newlines. Line/column offsets remain valid for any
  downstream check, identical to the convention all sibling packs
  follow.
- **Centralised primitives.** The scanner reuses
  `scanRegularString` for `"..."` and `applyRegions` for the overlay,
  rather than re-implementing the escape/newline logic locally. This is
  the documented purpose of `core/languages/strip-utils.ts`.
- **Backtick raw-string handling.** The branch at `strip.ts:55-62`
  walks from `` ` `` to the next `` ` `` with no escape interpretation —
  which is exactly the Go spec ("Raw string literals are character
  sequences between back quotes [...]; in particular, backslashes have
  no special meaning"). The test at `adapter.test.ts:30-40` exercises
  the multi-line case and asserts newline preservation.

## Findings

### 1. `parse` declares non-null return but contract permits `null` — and the type signature lies

- **Files / code:** `packages/languages/lang-go/src/parse.ts:22-28`,
  `packages/core/src/languages/adapter.ts:29`.
- **Pattern / principle:** Honest typing — the type should express the
  contract, not over-promise. The `LanguageAdapter` contract says
  `parse(content, filePath): TTree | null` ("Returns null on parse
  failure"). `parseGo`'s declared return type is `GoTree | null`, but
  the body unconditionally returns a non-null object. A caller that
  reads the type and the body together cannot tell whether the `| null`
  is reserved future capacity or a real possibility.
- **Status:** Issue — minor, but symmetric across `lang-java` and
  `lang-python` (same MVP shape). Worth fixing in one place.
- **Why it matters:** Callers in `fitness` that handle
  `tree === null` are dead code today for the Go adapter. When
  tree-sitter integration arrives (the file's own header comment
  promises this), parse failure becomes a real possibility and the
  caller behaviour will silently change. The current shape masks that
  transition.
- **Recommendation:** Either narrow the return type to `GoTree` (and
  drop `| null` until tree-sitter arrives) or document at the function
  level — via a `@returns` tagblock — that the MVP cannot fail. Prefer
  the narrower type; it's a no-op rename when tree-sitter lands and
  the return type widens to `GoTree | null` again.

### 2. Cross-pack scanner scaffold is duplicated four times

- **Files / code:** `packages/languages/lang-go/src/strip.ts:20-102`,
  `packages/languages/lang-java/src/strip.ts:22-132`,
  `packages/languages/lang-rust/src/strip.ts:21-162`,
  `packages/languages/lang-cpp/src/strip.ts:17-123`.
- **Pattern / principle:** DRY at the scaffold level (not at the
  language-specific level). The outer state machine — `while (i < len)
  { c = src[i]; next = src[i+1]; ...detect line comment... ...detect
  block comment... ...handle quotes... }` — is byte-identical across
  Go, Java, Rust, and C++ for line comments. Block comments are
  identical for Go/Java/C++ (non-nesting); Rust is the only outlier
  (nesting). The "fall through to `i++` when nothing matches" tail is
  identical everywhere. Each pack also has the same
  `interface Scan { stringRegions, commentRegions }`,
  the same `// eslint-disable-next-line sonarjs/cognitive-complexity`
  rationale, and the same final `stripStrings`/`stripComments`
  delegation to `applyRegions`.
- **Status:** Issue — recognised but not addressed. The header comment
  in `packages/core/src/languages/strip-utils.ts:26-34` already
  documents the future expectation that more helpers will move into
  core ("the same helpers are likely to be needed by future language
  adapters (Ruby, PHP, Swift, etc.)").
- **Why it matters:** Every new language pack today copies ~40 lines of
  scaffold and tweaks two slots (which quote characters open string
  states, which prefixes precede them). That copy-paste is also the
  place spec corners get missed (see findings 3 and 4). Extracting a
  `scanWithDelegates({ onLineCommentStart, onBlockCommentStart,
  onStringStart, ... })` primitive — or a structural
  `runScanner(src, lexerTable)` driver — would make the
  language-specific portion of each pack 10–20 lines instead of
  ~100, and fixes propagate uniformly.
- **Recommendation:** Phase 1 — promote `scan()`'s outer
  loop + line-comment + non-nesting block-comment scaffold into
  `core/languages/strip-utils.ts` as `runRegionScanner(src, hooks)`.
  Each hook returns either `null` (not my token, advance one char) or
  `{ regions, advanceTo }`. `lang-go`'s `strip.ts` then collapses to a
  ~40-line table: backtick-handler, double-quote-handler,
  rune-handler. Phase 2 — when adding lang #5 (Python) and #6 (Ruby),
  the savings compound. Defer Rust nesting block-comment as a
  per-pack hook since it is genuinely different.

### 3. Go raw-string spec quirk: `\r` discard is not represented

- **Files / code:** `packages/languages/lang-go/src/strip.ts:55-62`.
- **Pattern / principle:** Spec fidelity for region-content semantics.
  The Go specification states that "carriage return characters ('\r')
  inside raw string literals are discarded from the raw string value."
  The strip routine doesn't need to perform that discard — it's only
  marking regions for replacement, not extracting content — so the
  current behaviour is correct for `stripStrings`/`stripComments`.
- **Status:** Non-issue *for the current adapter surface*, but worth
  flagging for future `findStringLiterals` (`LanguageQueryAPI`) work.
  When the adapter starts returning the *value* of string literals
  (not just regions), the `\r`-discard rule must be applied to
  backtick strings, and a test on a CRLF-saved Go file becomes a
  required regression.
- **Why it matters:** If `query.findStringLiterals` is added later by
  re-using the existing scanner, the regions are correct but the
  extracted text would include `\r` characters that Go's lexer would
  not. This produces wrong results for any check that compares string
  contents to known constants on Windows-checked-out repositories.
- **Recommendation:** Add a doc comment on the raw-string branch
  noting the `\r`-discard rule, and add a TODO referencing the
  query-API future. No code change today.

### 4. Rune-literal scanner is permissive — silently consumes invalid input across newlines and EOF

- **Files / code:** `packages/languages/lang-go/src/strip.ts:73-96`.
- **Pattern / principle:** Defensive lexing. The rune branch advances
  `i = j` once the loop exits, which happens on close-quote (good),
  newline (acceptable — bails to outer loop), or EOF (acceptable).
  However, the loop also keeps `escape = true` when the escape
  character is the last char before EOF, and silently swallows
  arbitrary content between `'` and the next `'` even when the
  intervening content is not a single rune (e.g., `'abc'`). Go's lexer
  would reject `'abc'` as a syntax error.
- **Status:** Non-issue for region detection (we deliberately do *not*
  strip rune literals, and the over-broad scan only affects how far
  `i` advances), but it is a latent risk if anyone later repurposes
  this scanner for diagnostics.
- **Why it matters:** A check that looks at this function and assumes
  "everything between `'` and `'` is a valid rune" would be wrong.
  The `findCallsTo` family of `LanguageQueryAPI` methods will
  eventually want to skip over rune literals correctly without
  consuming code that *looks like* an unterminated rune (e.g., a
  stray `'` left over from a removed identifier).
- **Recommendation:** Add a test that asserts `'abc'` followed by
  legitimate code is *not* misread (i.e., the scanner stops at the
  closing `'` and resumes correctly). If/when an AST replaces this
  scanner, the rune branch can be deleted.

### 5. Test coverage is thin for the Go-specific edge cases that justify a custom strip

- **Files / code:**
  `packages/languages/lang-go/src/__tests__/adapter.test.ts:1-93`.
- **Pattern / principle:** Test the *non-trivial* contract. The
  current tests cover line comment, block comment, regular string,
  multi-line raw string, rune literal, and escape inside a regular
  string. Missing:
  - Backtick raw string containing `//` and `/* */` sequences (asserts
    Go's "no comment recognition inside raw strings" rule).
  - Block comment containing `*/` early termination edge (the comment
    `/* a */ b */` — second `*/` should be code).
  - Unterminated raw string (open backtick to EOF).
  - Unterminated block comment (open `/*` to EOF — Go bails the
    inner loop at EOF; verify region is recorded).
  - Rune literal with an embedded backslash escape sequence
    `'a'` (no closing-quote false-positive).
- **Status:** Issue — same gap exists in `lang-java` and `lang-cpp`;
  `lang-rust` has slightly more thorough scanner tests.
- **Why it matters:** The whole reason this strip exists in TypeScript
  rather than being delegated to a Go-aware tool is to handle these
  edge cases. Without regressions in place, a future refactor (e.g.,
  finding 2's extraction) could silently break them.
- **Recommendation:** Add five tests covering the cases above. They
  are small and self-contained — should be a 30-line PR.

### 6. `parse.ts` and `adapter.ts` carry zero Go-specific information

- **Files / code:** `packages/languages/lang-go/src/parse.ts:1-29`,
  `packages/languages/lang-go/src/adapter.ts:1-18` vs.
  `packages/languages/lang-java/src/parse.ts:1-29`,
  `packages/languages/lang-java/src/adapter.ts:1-17`.
- **Pattern / principle:** "Three or more occurrences are a pattern."
  `parseGo` and `parseJava` are functionally identical apart from the
  type-alias name (`GoTree` vs `JavaTree`); the same is true of
  `lang-python`'s `parse.ts`. Each tree shape has the same three
  fields (`source`, `filePath`, `lineStarts`).
- **Status:** Issue — minor. Could be folded into a single
  `defineSourceTextTree<TName>()` helper in core, or a single
  `SourceTextTree` shared interface re-exported by each pack.
- **Why it matters:** Today, three packs each carry an identical
  ~30-line file. When tree-sitter integration arrives in any one of
  them, the file diverges and the duplication evaporates — but until
  then, every contributor copies the boilerplate. The risk is low,
  but the cleanup is essentially free if it's bundled with finding 2's
  refactor.
- **Recommendation:** Extract a `SourceTextTree` interface and a
  `buildSourceTextTree(content, filePath)` factory into
  `core/languages/strip-utils.ts` (or a new
  `core/languages/text-tree.ts`). Each MVP pack then re-exports a
  named type alias and a delegating function. When a real parser
  arrives, the pack inlines its own version and drops the import.

## Non-findings considered and dismissed

- **"`parse()` doesn't actually parse anything."** Considered: the
  function name is misleading. Dismissed: the contract is named `parse`
  on `LanguageAdapter`, the file's header comment is explicit about the
  MVP, and the return shape is genuinely useful (`source` + `filePath`
  + `lineStarts` is enough for text-pattern checks). Future
  tree-sitter integration replaces the body without changing the
  surface — exactly the design intent.
- **"`scanRegularString` is duplicated in `lang-rust`."** Considered:
  `lang-rust/src/strip.ts:170-198` reimplements `scanRegularString`
  locally. Dismissed for *this* audit because it's not a finding about
  `lang-go` — `lang-go` correctly uses the core helper. The Rust
  duplication should be a finding in the lang-rust audit.
- **"Backtick scanner doesn't handle escape sequences."** Considered:
  the loop at `strip.ts:55-62` walks past `\` characters with no
  special handling. Dismissed: this is correct per the Go spec — raw
  strings explicitly do not interpret escape sequences, including
  `` \` ``, so a backtick *always* terminates a raw string.
- **"Block comment doesn't nest."** Considered: the block-comment
  branch terminates on first `*/` rather than tracking depth.
  Dismissed: Go's block comments are non-nesting per the spec
  (unlike Rust's). The current behaviour matches `lang-java` and
  `lang-cpp`, which is correct.
- **"Plugin contract — no `opensipTools` marker in `package.json`."**
  Considered: third-party tools advertise themselves via
  `opensipTools.kind === 'tool'`. Dismissed: that marker is for the
  *tool* dispatcher in CLI, not for language adapters. Lang adapters
  are registered statically by the CLI bootstrap (`registerBundled
  LanguageAdapters` in CLI's `index.ts`), and `lang-go` is correctly
  exporting the `adapters` array that the bootstrap reads.
- **"`fileExtensions: ['.go']` ignores `.go.tmpl` and similar."**
  Considered: Go templates and generated `.go` source live in files
  with extra suffixes. Dismissed: the extension match is suffix-based
  in `core`, and `.go.tmpl` is text-templated Go that no static
  analyser should treat as Go source — it isn't valid Go until
  rendered. Restricting to `.go` is correct.
- **"`aliases: ['golang']` is unnecessary."** Considered: only `id`
  needs to be matched. Dismissed: legacy scope strings in user-authored
  recipes (`scope.languages: ['golang']`) are explicitly listed in the
  `LanguageAdapter` contract as the reason `aliases` exists. The
  alias is documented and intentional.
