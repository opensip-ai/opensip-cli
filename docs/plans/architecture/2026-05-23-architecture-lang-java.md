---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/lang-java"
package: "@opensip-tools/lang-java"
audience: [contributors, architects]
prior: docs/plans/architecture/2026-05-22-architecture-lang-java.md
---
# Architecture audit (delta) — @opensip-tools/lang-java

## Summary

Wave 1 lexer fixes (`4254e72`) and the C-family scaffolding adoption
from core (`3d65016`, supported by `701bef1`) have landed. `strip.ts`
is now 140 lines and delegates generic C-family lexing — line
comments, non-nesting block comments, regular strings, char literals —
to `@opensip-tools/core`'s `strip-utils.ts`. `parse.ts` collapsed to
a one-line wrapper around `buildMinimalTextTree`. SOLID is clean;
layering is clean (only `@opensip-tools/core`); the Java-specific
surface that remains is the text-block scanner — the right division
of labor.

All six prior findings are CLOSED. Net-new findings are three minor
observations; missed-in-prior is three low-severity drive-bys. The
package is in good architectural shape.

## Prior findings — verification

### F1: Text-block scanner does not honor `\"` and `\\` escapes — CLOSED

Verified at `strip.ts:73-94`. The body scan now tracks a `bodyEscape`
flag, evaluates it before the close-`"""` check, and recovers via an
explicit `closed` flag (the older `j >= len` guard that was off-by-one
at EOF is gone). Regression coverage added at `adapter.test.ts:74-83`
("does not prematurely close a text block on an escaped triple quote")
and `adapter.test.ts:86-94` ("recovers from an unterminated text
block at end of source"). Branch order matches the regular-string
scanner in core.

### F2: Char-literal scan is unbounded — CLOSED

Verified at `strip.ts:118-122`. Char-literal handling is now a single
delegation to core's `scanCharLiteral`, which caps at 8 chars by
default (`strip-utils.ts:294`) and on overflow returns
`end: start + 1` so the apostrophe is treated as code. Regression
coverage at `adapter.test.ts:97-103` ("does not swallow code on a
stray apostrophe") and `adapter.test.ts:107-112` ("closes a unicode-
escape char literal within the 8-char cap").

### F3: Lexer scaffolding duplicated across four C-family packs — CLOSED

Verified at `strip-utils.ts:89-332` (core helpers) and
`strip.ts:14-22` (lang-java imports). `scanLineComment`,
`scanBlockCommentNonNesting`, `scanRegularString`, `scanCharLiteral`,
and the `Region` interface all live in core. Lang-java's `strip.ts`
contains only the text-block scanner plus the outer dispatch loop —
which is the irreducible Java-specific surface. Lang-cpp, lang-go,
and lang-rust have all adopted the same core helpers per `3d65016`.
The `// eslint-disable-next-line sonarjs/cognitive-complexity` is
still present on `scan()` (`strip.ts:28`); given the dispatch-and-
delegate shape that remains, it is now justified rather than a
duplication smell.

### F4: `parse.ts` byte-identical across three packs — CLOSED

Verified at `parse.ts:17-23`. The implementation now reads:
`return buildMinimalTextTree(content, filePath)`. The shared
factory + `MinimalTextTree` interface live at
`packages/core/src/languages/text-tree.ts:28-53`. The `JavaTree`
brand alias is preserved at `parse.ts:19` so adapter generic-parameter
naming stays distinct, exactly as the prior recommendation requested.
Lang-go and lang-rust adopted the same factory in `3d65016`.

### F5: `parseJava` cannot return `null` — CLOSED (with caveat)

`JavaTree | null` survives at `parse.ts:21` to match the contract.
The prior ask was an inline comment; that landed centrally in
`text-tree.ts:7-19` instead, documenting MVP-vs-future once for all
MVP packs. Spirit satisfied; see N1 for an optional further nudge.

### F6: Char-literal escape branch ordering not commented — CLOSED

Verified at `strip.ts:114-117`. The call site has a three-line
comment ending "branch order is load-bearing — see core's
scanCharLiteral docstring and lang-java F6". The substantive
explanation (escape-reset must run before close-quote) lives at
`strip-utils.ts:280-287` and `strip-utils.ts:302-308`, where it
applies to all four C-family adapters. Test coverage at
`adapter.test.ts:116-122` ("parses an escaped-apostrophe char
literal '\\''") locks in the behavior.

## Net-new findings

### N1: F / Low / `parse.ts:21` / `JavaTree | null` return lacks inline anchor

- **F / Severity:** F (type honesty) / Low.
- **Where:** `parse.ts:21-23`.
- **What:** `parseJava` is typed `JavaTree | null` but the body
  cannot return null. `text-tree.ts:7-19` explains MVP-vs-future
  centrally, but a reader skimming `parse.ts` alone sees a dead
  `| null` with no local hint. Prior F5 risk (someone tightens the
  return type, then future tree-sitter swap-in is a breaking
  change) is reduced but not eliminated.
- **Why:** Contract honesty across abstraction boundaries.
- **Recommendation:** Either annotate the return
  (`// MVP shim cannot fail; tree-sitter may return null`) or
  widen the signature only when a real parser ships. Same point
  applies to lang-go and lang-rust — landing once in the
  `buildMinimalTextTree` docstring's consumer-facing guidance
  (`text-tree.ts:42`) settles it for all three.

### N2: F / Low / `strip.ts:61-104` / "Not a text block" fall-through is unpinned

- **F / Severity:** F (control-flow clarity) / Low.
- **Where:** `strip.ts:61-104`.
- **What:** When `"""` is not followed by a line terminator, the
  code falls through to the regular-string branch
  (`strip.ts:106-112`). `scanRegularString` sees `"` then `"`,
  returns at `contentEnd: i+1, next: i+2`, leaving the third quote
  for the outer loop. This is correct, but relies on a non-obvious
  invariant of `scanRegularString`'s empty-string fast path. A
  future change there (e.g. treating two adjacent quotes as an
  error) would silently break Java's not-a-text-block path. No
  test covers a `"""` opener that is *not* a text block.
- **Why:** Coupling between two helpers with no contract pin.
- **Recommendation:** Add a regression test (e.g.
  `String s = "";` adjacent to `""` patterns, or pin
  `String s = """abc"` as malformed-but-non-spinning input).
  Cost: ~5 lines.

### N3: GoF / Low / `strip.ts:29-128` / Outer dispatch loop still duplicated across four packs

- **F / Severity:** GoF / Low (open question, not a defect).
- **Where:** `strip.ts:29-128`, vs same loop in lang-go, lang-cpp,
  lang-rust.
- **What:** F3 closed leaf-scanner duplication, but the
  `while (i < len)` outer dispatch — switch on byte, call
  appropriate `scanX`, accumulate `stringRegions`/`commentRegions`
  — is still copy-pasted across the four C-family packs. Each
  pack adds 1-2 language-specific branches before the
  regular-string fallthrough. ~30 lines per pack.
- **Why:** GoF Strategy / Template Method. A
  `defineCFamilyStripDispatch({ extras: [...] })` factory in core
  would reduce each pack to its language-specific extras plus
  the wrapper barrel.
- **Recommendation:** Defer until a fifth C-family pack
  (Kotlin / Scala / Swift / C#) is on the roadmap. Three packs
  sharing scanners via core is already a sensible point on the
  duplication-vs-abstraction curve.

## Missed in prior audit

### M1: F / Low / `strip.ts:35-128` / Annotation handling correct but unpinned

- **F / Severity:** F (test coverage) / Low.
- **Where:** `strip.ts` outer loop; `__tests__/adapter.test.ts`.
- **What:** Java annotations (`@Foo`, `@Foo(value = "bar")`,
  `@interface Foo {}`) are pervasive. The scanner handles them
  correctly — `@` is an ordinary code byte and the string inside
  `@Foo("bar")` is caught by the regular `c === '"'` branch
  (`strip.ts:107`) — but no test pins it. The prior audit's
  non-findings dismissed numeric separators and text-block
  delimiters but didn't consider annotations.
- **Why:** Annotations are the most pervasive Java-specific
  syntactic feature that touches strings.
- **Recommendation:** Add a test like
  `@SuppressWarnings("unchecked") void m() {}`; assert
  `"unchecked"` content is stripped while wrapper code survives.
  Cost: ~5 lines.

### M2: F / Low / `strip.ts:118-122` / Lifetime heuristic absence uncommented

- **F / Severity:** F (cross-language consistency) / Low.
- **Where:** `strip.ts:114-122`.
- **What:** `scanCharLiteral`'s docstring (`strip-utils.ts:285-287`)
  references "lang-rust (with the lifetime-vs-literal heuristic at
  the call site)". A reader at Java's call site may wonder if the
  same heuristic is needed (it isn't — Java has no lifetimes).
- **Why:** Missed because the helper was single-purpose before
  extraction; serving both Rust and Java now, the caller-
  responsibility difference deserves a note.
- **Recommendation:** Optional one-line addition to the existing
  comment: "Java has no Rust-style lifetime ambiguity; no pre-check
  needed."

### M3: F / Low / `strip.ts:32-34` / "Must advance i" invariant undocumented

- **F / Severity:** F (state-machine documentation) / Low.
- **Where:** `strip.ts:32-128`.
- **What:** The outer loop relies on every branch advancing `i`
  (via `result.next` / `result.end` or the `i++` fallthrough at
  line 124). A future branch that forgets to advance — or misuses
  `result.end` (`scanCharLiteral` returns `start + 1` on overflow,
  which is implicit) — would spin.
- **Why:** Missed in the prior audit because the loop was simpler
  pre-extraction; post-extraction the trust boundary spans three
  helper contracts.
- **Recommendation:** Optional invariant comment above the loop
  ("each branch must advance i"); or a dev-mode assertion
  (`if (newI === i) throw ...`).

## Overall

- **SOLID:** Clean. SRP — `parse.ts` does line-offset metadata,
  `strip.ts` does region discovery, `adapter.ts` does contract
  assembly. DIP — lang-java depends on `LanguageAdapter` and the
  core `Region`/scanner abstractions, not concrete implementations.
- **Adapter correctness (GoF Adapter):** `javaAdapter`
  (`adapter.ts:7-13`) is a faithful Adapter from Java-specific
  scanners to `LanguageAdapter<TTree>`. The `JavaTree` brand alias
  preserves a distinct type parameter for a future tree-sitter swap.
- **Layering:** Clean. `package.json` declares only
  `@opensip-tools/core`. No imports from peer language packs,
  fitness, simulation, contracts, or cli.
- **Java-specific lexer issues:** Text blocks (correct, F1 fix),
  char literals (bounded, F2 fix), annotations (correct by
  inheritance, unpinned — M1), comments (delegated to core).
- **Net direction:** `strip.ts` is 140 lines, `parse.ts` is 23 —
  the irreducible Java-specific minimum. Three open recommendations
  (N1, N2, N3) are cosmetic or speculative; three missed
  observations (M1, M2, M3) are cheap drive-bys.

No blocking action required; optional follow-ups total ~15 lines
of comments and tests.
