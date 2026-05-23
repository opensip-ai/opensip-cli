---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/lang-python"
package: "@opensip-tools/lang-python"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/lang-python

## Summary

`@opensip-tools/lang-python` implements the `LanguageAdapter` contract for
Python (`.py`, `.pyi`) and is shaped exactly like its peers `lang-rust`,
`lang-go`, and `lang-java`: a four-file package (`index.ts`, `adapter.ts`,
`parse.ts`, `strip.ts`) where `parse()` returns a minimal `{source,
filePath, lineStarts}` placeholder until tree-sitter integration lands,
and the real work lives in a hand-written `strip.ts` lexer.

The strip lexer is the most domain-specific in the family. Python's
lexical grammar is denser than C-family languages (two quote characters
both legal for non-triple strings; triple-quoted multiline strings;
case-insensitive 1- and 2-char prefixes `r/b/u/f/rb/br/rf/fr`; raw
strings that suppress *some* escape handling). The implementation is
**not** regex-based, **not** copy-pasted from a sibling pack, and is
properly token-state-machine in shape — three substantive findings
below are the small correctness edges, not architectural issues.

The adapter is correctly sized for core's strict-kernel rule
(import-only on `applyRegions`, `Region`, `buildLineStarts` from
`@opensip-tools/core`, no peer imports), the public surface is the
expected `pythonAdapter` + `adapters` array, and the test file covers
the documented behaviors including the f-string MVP limitation.

## Existing patterns (correct usage)

- **Adapter shape matches siblings exactly.** `adapter.ts` exports
  `pythonAdapter: LanguageAdapter<PythonTree>` with `id`, `fileExtensions`
  (`.py`, `.pyi`), `aliases` (`['py']`), `parse`, `stripStrings`,
  `stripComments` and re-exports as the plugin-contract `adapters` array.
  Identical structural footprint to `rustAdapter`, `goAdapter`, `javaAdapter`.
- **`parse.ts` is the documented MVP shim.** `PythonTree` is the same
  `{source, filePath, lineStarts}` triple used by lang-rust / lang-go /
  lang-java, with the same future-tree-sitter docblock and the same
  `buildLineStarts` import from core. No drift across the family.
- **No subpath imports beyond the documented `core/languages/adapter.js`.**
  Layering is clean: the adapter depends only on `@opensip-tools/core`;
  no `@opensip-tools/fitness`, no peer language packs, no contracts/cli.
- **Length-preserving region overlay via `applyRegions`.** Strings and
  comments are recorded as `Region[]` and applied at the end, identical
  to every sibling — line/column offsets remain stable for downstream checks.
- **Hand-written prefix lexer rather than regex.** `matchStringStart`
  is a dedicated character classifier (`isAsciiLetter`, `isIdentChar`)
  with explicit two-char-prefix-first ordering — no regex backtracking,
  no nested-quote ambiguity. This is the *correct* shape for a strip
  lexer; the watch-item "regex-based strip routines that mishandle
  nested quotes" does not apply here.
- **Identifier-boundary check on prefixes.** `matchStringStart` rejects
  prefixes when `prev` is an identifier character, so `broken = 1`,
  `myvar`, etc. are not mistaken for `b'roken'` or `f`-prefix starts.
  This is exercised by the "preserves identifiers that begin with
  prefix-like letters" test.
- **f-string limitation is acknowledged, documented, and tested.**
  The header docblock explicitly says expression interpolation is
  treated as string content, the test asserts `name` inside `f"hello
  {name}"` is stripped, and the rationale (defer to tree-sitter) is
  stated. Given the MVP framing this is a sensible design choice, not a
  defect.

## Findings

### Raw-string quote-escape handling diverges from CPython

- **Files / code:**
  - `packages/languages/lang-python/src/strip.ts`, `scanSingleString`
    (lines 127–156) and `scanTripleString` (lines 102–125), both gated
    by `if (!isRaw && ch === '\\')`.
- **Pattern / principle:** Adapter correctness — strip routines must
  not under- or over-consume relative to the language spec.
- **Status:** Minor correctness hole, almost certainly never exercised
  by real code.
- **Why it matters:** CPython's tokenizer says that *even in raw
  strings*, a backslash before a quote prevents the quote from ending
  the literal (the backslash is still kept in the value, but the quote
  is not a terminator). Concretely, `r"\""` is the 2-char string
  `\"`, not a syntax error; the closing `"` is the third quote, not
  the second. The current implementation, on `isRaw === true`, takes
  the `\\`-handling branch off entirely, so `\` is treated as an
  ordinary character and the next `"` terminates the string. Result:
  on input like `r"\""`, the scanner closes the string at the first
  `"` after `\` and then treats the remainder as code. In practice
  this mis-tokenizes a vanishingly small population of real Python
  files (most raw strings use this pattern only inside docstrings and
  regex test inputs), but it is a real divergence from the language
  spec and from sibling implementations — `lang-rust` and the
  shared `core/scanRegularString` both honor `\<anything>` even
  in non-raw positions. Triple-quoted raw strings are subject to
  the same edge case, though triple-raw with a trailing `\` before
  the closing `"""` is exceptionally rare.
- **Recommendation:** In `scanSingleString` and `scanTripleString`,
  keep the existing escape handling for `isRaw === true` *but only for
  the purpose of advancing past `\<quote>`* — i.e. do `i += 2` for
  `\"` / `\'` / `\\` even in raw strings. Do not turn this into a
  full escape parser; the existing 2-char skip is sufficient.
  Add a regression test like `r'\\\''` (single-line raw) and the
  triple-raw analogue. This brings the lexer in line with CPython's
  tokenizer rule and removes the asymmetry with `lang-rust`'s raw-string
  handler.

### Disambiguating `""` (empty string) from `"""` (triple-quote opener)

- **Files / code:**
  - `packages/languages/lang-python/src/strip.ts`, lines 178–193 in
    `scan` — the triple-quote check `src[quoteIndex + 1] === quote &&
    src[quoteIndex + 2] === quote`.
- **Pattern / principle:** Greedy-vs-conservative tokenization for
  ambiguous prefixes.
- **Status:** Working-as-intended; worth pinning with a test so a
  future "fix" doesn't regress it.
- **Why it matters:** In Python, three consecutive `"` characters
  always open a triple-quoted string — `""` followed immediately by
  another `"` (no whitespace) is not legal as two separate empty-string
  literals. The current code does the right thing by greedily matching
  triple. However, there is no explicit test for the empty-triple
  edge case (`""""""` — six quotes, an empty triple-string) or the
  paired-empty-string case (`"" ""` — two empty strings, separated by
  whitespace). The first should round-trip cleanly; the second should
  be tokenized as two single-quoted empties. Without coverage, a
  well-meaning refactor of `matchStringStart` could break either.
- **Recommendation:** Add two regression tests: `x = """"""` (must be
  one empty triple, not three empty pairs) and `x = "" ""` (must be
  two empty single-quoted strings). Keep the greedy-triple semantics —
  it matches CPython.

### `parse.ts` is the same MVP shim as four siblings — extraction candidate

- **Files / code:**
  - `packages/languages/lang-python/src/parse.ts` (28 lines)
  - `packages/languages/lang-rust/src/parse.ts` (28 lines, byte-identical
    except for the type name and docblock language)
  - `packages/languages/lang-go/src/parse.ts` (same shape)
  - `packages/languages/lang-java/src/parse.ts` (same shape)
- **Pattern / principle:** DRY across the language-adapter family —
  but balanced against "premature abstraction is worse than duplication"
  for a kernel.
- **Status:** Intentional duplication today; revisit when tree-sitter
  lands.
- **Why it matters:** Four packages currently ship effectively the
  same `parse()` body — `{source, filePath, lineStarts:
  buildLineStarts(content)}` — wrapped in a per-language interface name
  (`PythonTree`, `RustTree`, `GoTree`, `JavaTree`). The duplication is
  cheap (28 lines, no logic) and it preserves the future-flexibility
  story: each pack will replace its `parse()` with a tree-sitter call
  independently, and the per-language `TTree` shape will diverge.
  Extracting a shared `MinimalTree` into core today would have to be
  un-extracted later when each pack grows real ASTs, so the current
  duplication is *correct* under the kernel's "no fitness-shaped logic
  in core" rule. The risk is that someone "helpfully" DRYs this and
  creates a coupling that has to be undone.
- **Recommendation:** Leave it duplicated. Add a one-line note to the
  parse.ts header docblock saying "this shape is duplicated across
  lang-* packs intentionally; each pack will replace `parse()`
  independently when tree-sitter integration arrives" so the next
  reviewer doesn't propose extraction. No source change needed in
  lang-python until then; the docblock could be added in a follow-up.

### Single-string scanner's newline-as-terminator silently swallows the newline

- **Files / code:**
  - `packages/languages/lang-python/src/strip.ts`, `scanSingleString`
    lines 141–143: on `ch === '\n'`, returns `{contentEnd: i, next: i}`.
- **Pattern / principle:** Recovery semantics for malformed input.
- **Status:** Correct in spirit; mildly under-specified vs siblings.
- **Why it matters:** When a non-triple Python string is unterminated
  before a newline, the scanner returns `next: i` (the position of the
  newline itself) so the outer loop re-encounters the newline and skips
  it as ordinary code. That is the same recovery shape `core/scanRegularString`
  uses (`{contentEnd: i, next: i}`), so it is consistent with the rest
  of the family. However, the comment says "treat newline as a
  terminator to avoid eating the rest of the file on malformed input"
  — which is fine as recovery, but masks two distinct cases: real
  Python (line continuation via `\` at end of line, which the
  `\\<anything>` branch already handles correctly) and genuine
  syntax errors. There's no test for either path. A future contributor
  could see "newline terminates" and "weaken" it, breaking line
  continuation.
- **Recommendation:** Add two tests: (a) `x = "abc\\\nxyz"` (line
  continuation; `xyz` should be inside the string region — this works
  today because `\\` skips two chars including the `\n`); (b) `x =
  "abc<newline>def"` (unterminated; the scanner should not strip
  `def`). Tests pin the behavior; no source change required.

### `parse()` never returns `null` despite contract permitting it

- **Files / code:**
  - `packages/languages/lang-python/src/parse.ts` line 22 always returns
    a tree.
  - Contract: `packages/core/src/languages/adapter.ts` line 29:
    `parse(content: string, filePath: string): TTree | null`.
- **Pattern / principle:** Contract conformance — return-type signals
  failure semantics.
- **Status:** Working-as-intended at the MVP layer; the contract's `|
  null` is reserved for tree-sitter parse failures that don't exist yet.
- **Why it matters:** Every shim-parse adapter (Python, Rust, Go, Java)
  always returns a non-null tree because the "parse" is effectively
  free — `buildLineStarts` cannot fail. Once tree-sitter lands, real
  parse errors will start producing `null`, and any check that today
  assumes "parse never returns null for Python" will silently break.
  The contract is correct (`| null` is the right signature) but the
  *consumers* are the risk surface.
- **Recommendation:** No change in lang-python. As a follow-up not
  scoped to this audit: audit the fitness check packs for any code
  that drops the `null` from `adapter.parse()` without a guard. If
  such code exists, add a `?? null` guard or an early-return so the
  tree-sitter migration is a no-op for callers.

### `query` not implemented — graceful, but documents nothing

- **Files / code:**
  - `packages/languages/lang-python/src/adapter.ts` — no `query`
    property.
  - `packages/core/src/languages/adapter.ts` line 38: `readonly query?:
    LanguageQueryAPI<TTree, TNode>` (optional).
- **Pattern / principle:** Optional contract surface — adapters that
  cannot implement `query` simply omit it.
- **Status:** Working-as-intended; matches lang-rust / lang-go /
  lang-java / lang-cpp.
- **Why it matters:** `query` is the cross-language generic-query
  interface (`findFunctions`, `findImports`, `findCallsTo`, etc.). It
  is genuinely impossible to implement on the current `PythonTree`
  shape — there is no AST. Omitting it is correct. The risk is purely
  documentation: a check author who sees `pythonAdapter` and tries to
  call `pythonAdapter.query?.findFunctions(...)` gets `undefined` at
  runtime and may not understand why. The same is true of every other
  shim-parse pack.
- **Recommendation:** No source change. Optionally, in a follow-up
  README or in the `parse.ts` docblock, add a one-line note: "Until
  tree-sitter lands, `query` is intentionally undefined; checks that
  need cross-language query semantics should restrict their scope to
  languages whose adapters expose `query` (today: lang-typescript)."

## Non-findings considered and dismissed

- **"Strip logic could be regex-based and brittle."** It is not. The
  scanner is a hand-written character-by-character lexer with explicit
  state for prefix matching, triple-quote detection, raw-string flag,
  and escape handling. There are no `RegExp` instances anywhere in
  `strip.ts`. The watch-item from the audit prompt does not apply.
- **"Strip routine copy-pasted from a sibling pack."** It is not.
  Compared side-by-side with `lang-rust/strip.ts`, `lang-go/strip.ts`,
  `lang-java/strip.ts`, and `lang-cpp/strip.ts`, the Python scanner
  shares the high-level `scan() -> {stringRegions, commentRegions}`
  organization (which is the correct family pattern, not duplication)
  but the body is uniquely Python: only Python supports both `'` and
  `"` for non-triple strings, only Python has `r/b/u/f/rb/br/rf/fr`
  prefixes, only Python uses `#` comments, and the implementation
  reflects that. Notably, `scanRegularString` from
  `core/strip-utils.ts` is *not* used by Python — and rightly so,
  because that helper is hard-coded to `"` and would not handle Python's
  single-quoted strings. Going through `scanRegularString` would
  require it to take a quote-character parameter, which would be a
  reasonable refactor but is out of scope for this audit.
- **"Missing parse implementation."** `parse()` is present and
  intentional — it returns the documented MVP `{source, filePath,
  lineStarts}` shape. The MVP framing is explicit in both the
  docblock and the package's `CLAUDE.md` mention of language adapters.
  Not a finding.
- **"`stringRegions` and `commentRegions` could overlap."** They
  cannot, because `scan()` decides comment-vs-string-vs-other at each
  position with `continue` after consuming the entire token. There is
  no path that records the same byte twice. `applyRegions` would
  tolerate overlap anyway (it overwrites `' '` with `' '`).
- **"`isAsciiLetter` rejects Unicode identifiers; Python supports
  Unicode identifiers."** Python does, but Python *string prefixes*
  are restricted to the eight ASCII forms `r/b/u/f/rb/br/rf/fr` (case
  insensitive). A Unicode-named variable adjacent to a string is
  handled correctly because `matchStringStart` only triggers on ASCII
  letters; everything else falls through to the per-character `i++`.
  No bug.
- **"Aliases should include `python3`."** Python 2 vs 3 is a tooling
  concern, not a file-extension concern. `.py` files are the same
  filename whichever interpreter consumes them. Adding `python3` as an
  alias would create matching ambiguity with no benefit. Not a finding.
- **"`adapter.ts` and `index.ts` re-export the same symbol twice."**
  `index.ts` does `export { pythonAdapter, adapters } from './adapter.js'`
  — that's a barrel re-export, which is the standard pattern across
  every adapter pack. Not duplication.
