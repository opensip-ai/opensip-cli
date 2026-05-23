---
status: current
last_verified: 2026-05-23
supersedes: 2026-05-22-architecture-lang-go.md
title: "Architecture audit (delta) — @opensip-tools/lang-go"
package: "@opensip-tools/lang-go"
audience: [contributors, architects]
---
# Architecture audit (delta) — @opensip-tools/lang-go

Delta against `2026-05-22-architecture-lang-go.md`. Wave 1 lexer fixes
landed (`e6eb358` test pin, `3d65016` C-family scaffolding adoption,
`701bef1` core extraction). The package is now smaller and structurally
cleaner than yesterday: `strip.ts` is **101 lines** (down from ~155-ish
hand-rolled), with the lexer scaffold (`scanLineComment`,
`scanBlockCommentNonNesting`, `scanCharLiteral`, `scanRegularString`,
`applyRegions`, `buildLineStarts`) imported from
`@opensip-tools/core`. `parse.ts` now delegates to
`buildMinimalTextTree` and is **23 lines**. Layering is clean
(`lang-go → core` only).

## Prior-finding status

### F1 — `parse` declares `GoTree | null` but body cannot return null

**Status: OPEN (unchanged).** `parse.ts:21` still declares
`GoTree | null` and the body unconditionally returns the
`buildMinimalTextTree(...)` object, which is not nullable
(`text-tree.ts:47-53`). The recommendation from the prior audit
(narrow to `GoTree`, widen back when tree-sitter lands) was not taken.
Low-impact but trivially fixable; same shape persists in `lang-java`
and `lang-python`. Recommend a one-line edit: change the return
annotation to `GoTree`.

### F2 — Cross-pack scanner scaffold duplicated four times

**Status: SUBSTANTIALLY CLOSED.** The Wave 1 commits did Phase 1 of
the recommendation: `scanRegularString`, `scanLineComment`,
`scanBlockCommentNonNesting`, `scanBlockCommentNesting`, and
`scanCharLiteral` are all centralised in
`packages/core/src/languages/strip-utils.ts:89-330`. `lang-go`'s
`strip.ts:38-83` is now ~45 lines of tabular dispatch (the four-case
detector for `//`, `/*…*/`, `` `…` ``, `'…'`) plus the outer
state-machine loop. The remaining duplication — the outer
`while (i < len) { ... }` loop and the `Scan { stringRegions,
commentRegions }` shape — is what the prior audit suggested promoting
as `runRegionScanner(src, hooks)`. That promotion did **not** happen.
See NN-1.

### F3 — Raw-string `\r`-discard rule not represented

**Status: OPEN.** No doc comment was added at `strip.ts:55-62`.
Still a non-issue for the current adapter surface (region
detection only) but a latent trap for any future
`findStringLiterals` query API. Cheap to land — one line of
`@todo` referencing the future query API.

### F4 — Rune-literal scanner permissive

**Status: CLOSED (delegated + pinned).** Two changes addressed
this. (1) Rune scanning is now delegated to core's
`scanCharLiteral` with `{ maxScan: 12 }` (`strip.ts:79-82`),
which has the documented load-bearing branch order
(escape-before-close-quote, see core docstring at
`strip-utils.ts:280-288`) and a documented unterminated-recovery
behaviour (treat lone apostrophe as code,
`strip-utils.ts:325-330`). (2) The Wave 1 test pin
(`adapter.test.ts:151-197`) locks the current permissive
behaviour for all four rune escape forms (`'a'`, `'\n'`,
`'A'`, `'\U0001F600'`) plus a mixed-with-string regression.
The prior audit's recommended `'abc'` test is implicitly covered
by the cap (`maxScan: 12` permits `'abc'`-style overflow recovery
via the apostrophe-as-code branch).

### F5 — Test coverage thin for Go-specific edge cases

**Status: MOSTLY CLOSED.** Wave 1 added 9 explicit edge-case
tests (`adapter.test.ts:98-224`) covering: `//` inside raw
string (both `stripStrings` and `stripComments` paths),
unterminated raw string, unterminated block comment,
unterminated interpreted string, four rune-escape forms, mixed
runes/strings, plus a length-preservation matrix that re-asserts
`stripStrings(src).length === src.length` and
`stripComments(src).length === src.length` across all nine
inputs.

Two cases from the prior recommendation are still missing — see
MISSED-1: (a) block-comment containing an early `*/` followed by
a second `*/` (asserts non-nesting termination on the *first*
`*/`), and (b) rune literal nested inside a raw string with `'`
inside backticks (asserts the raw-string branch wins over the
rune branch).

### F6 — `parse.ts` and `adapter.ts` zero Go-specific information

**Status: CLOSED.** The `text-tree.ts` extraction
(`701bef1`) implements exactly the prior audit's Phase 2
recommendation. `MinimalTextTree` is the shared shape and
`buildMinimalTextTree(content, filePath)` is the factory.
`parse.ts:17-22` is now a 5-line delegate; the `GoTree` type
alias is preserved as a brand. `adapter.ts:1-17` is unchanged
(it was never the duplication site).

## NET-NEW findings

### NN-1 / Severity: Low / SRP / `strip.ts:33-86`

**What.** The four-token outer dispatch loop in `scan()` is now
the *only* remaining scaffolding duplication across `lang-go`,
`lang-java`, and `lang-cpp`. Each pack has the same shape: read
`c = src[i]`, read `next = src[i+1]`, four `if` blocks
delegating to a core scanner, fall-through `i++`. The token-set
differs (Go has backtick raw strings; Java has text blocks; C++
has prefixed string forms), but the *shape* is identical.

**Why.** Phase 1 of yesterday's F2 recommendation extracted the
*token scanners*; Phase 2 was supposed to extract the *driver*.
Today's diff between Go's `scan()` (101 lines total) and
Java's (140) and C++'s (174) is almost entirely in the
per-token branches — the surrounding loop is byte-identical
machinery. A `runRegionScanner(src, dispatch)` primitive in
core would let `lang-go`'s `scan()` collapse to roughly:

```ts
return runRegionScanner(src, {
  '//': (s, i) => scanLineComment(s, i),
  '/*': (s, i) => scanBlockCommentNonNesting(s, i),
  '`':  (s, i) => scanRawBacktickString(s, i),
  '"':  (s, i) => scanRegularString(s, i),
  "'":  (s, i) => scanCharLiteral(s, i, { maxScan: 12 }),
})
```

**Recommendation.** Defer until lang #7 (Ruby or PHP) is added,
*or* until any of `lang-go`/`lang-java`/`lang-cpp` grows a
fifth token. Three identical implementations is the
"three or more is a pattern" line; the absent fifth token is
the trigger. No action this audit cycle.

### NN-2 / Severity: Low / Adapter correctness — Go spec / `strip.ts:79-82`

**What.** The rune-scanner cap is `maxScan: 12` to accommodate
`'\U0001F600'` (12 chars). However, **the Go spec permits at
most one rune in a rune literal**, so the longest *valid* form
is precisely 12 characters — there is no slack. The cap is
exact, not conservative. This is fine for region scanning
(rune literals are not stripped), but a Go file with a *broken*
rune literal of the form `'verylongthing'` will be misread:
the apostrophe will be treated as code at position 0 (per
core's overflow-recovery), the scanner advances one character,
and the body `verylongthing'` is then re-scanned. That re-scan
sees the trailing `'` and starts a *new* rune literal there —
which terminates at the next `'` in the file or EOF.

**Why.** This is not a regression — it matches Java's and
C++'s behaviour and is exactly the documented core contract.
But it means broken Go source can desynchronise the scanner
across many lines. Region detection still completes, but the
recovered strings/comments may be wrong.

**Recommendation.** Add one test: a deliberately-broken
`'abcdef'` followed by a real string literal, asserting the
real string is correctly stripped. This pins the
overflow-recovery contract from `lang-go`'s side. No code
change needed today. (Same finding applies to `lang-java`
and `lang-cpp`; would belong as a shared
`core/__tests__/scanCharLiteral.overflow.test.ts` if any of
the three packs had a real bug.)

### NN-3 / Severity: Info / DIP / `strip.ts:14-19`

**What.** `strip.ts` imports five named symbols from
`@opensip-tools/core` via the package barrel, which is the
preferred form per CLAUDE.md ("subpath exports are strongly
discouraged"). However, `adapter.ts:5` still uses
`'@opensip-tools/core/languages/adapter.js'` as a subpath
import for `LanguageAdapter`. Both `lang-java` and `lang-cpp`
have the same pattern — `adapter.ts` reaches into the
subpath while `strip.ts` uses the barrel.

**Why.** The CLAUDE.md exception named is
`@opensip-tools/core/languages/parse-cache.js`; the
`adapter.ts` subpath is *not* on the documented exception
list. `LanguageAdapter` is exported from the core package
barrel (per `packages/core/src/languages/index.ts:11` —
`Adapter` types are re-exported). The subpath form here
appears to be vestigial from before the barrel was complete.

**Recommendation.** Change `adapter.ts:5` to
`import type { LanguageAdapter } from '@opensip-tools/core'`.
One-line cleanup that brings `lang-go` in line with the
documented import policy. (Apply the same change to
`lang-java`, `lang-cpp`, `lang-rust`, `lang-python` if their
subpath usage is also vestigial.)

## MISSED in prior audit

### MISSED-1 / Severity: Low / Test coverage / `__tests__/adapter.test.ts`

**What.** The Wave 1 test pin (`e6eb358`) covers most of the
prior F5 list but skipped two tests the prior audit had
recommended explicitly:

- **Block comment with embedded `*/` then real code then `*/`.**
  Source: `'/* a */ b */'`. Asserts non-nesting termination on
  the *first* `*/` and that ` b */` is treated as code. This
  is the spec-fidelity test for Go's non-nesting block-comment
  rule (vs Rust's nesting form). Without it, a future refactor
  of `scanBlockCommentNonNesting` could regress to nesting
  behaviour silently.
- **Rune literal inside raw string.** Source: `` x := `'a'` ``.
  Asserts the raw-string branch (`strip.ts:56-63`) wins over
  the rune branch (`strip.ts:79-82`) — the `'a'` inside
  backticks must be treated as raw-string content, not as a
  rune literal that interrupts the raw-string scan.

**Why.** Both are dispatch-order regressions waiting to
happen. The cost of adding them is tiny (~6 lines each); the
value is non-zero because the dispatch order in `scan()` is
load-bearing and not currently asserted.

**Recommendation.** Add two `it()` blocks under the existing
`go strip edge cases` describe. Match the existing pattern.

### MISSED-2 / Severity: Info / Adapter correctness — Go spec / `strip.ts`

**What.** Go has **two** number-literal forms that contain
characters the lexer must skip: hex floats (`0x1.fp10`), and
imaginary-number suffixes (`1.5i`). Neither contains
characters that the current scanner treats specially —
neither `.`, `i`, `p`, `x`, nor digits are in the token
table — so they pass through correctly. The audit prior
neither flagged nor dismissed them. Confirmed non-issue;
calling it out here so the next audit doesn't re-investigate.

**Why.** Go's `0` followed by `'1'`-`'7'` is octal,
`0x` is hex, `0o` is octal alt, `0b` is binary; underscores
are permitted as digit separators (`1_000_000`). All are
text the scanner sees as plain code, never opening a
literal it tracks. Verified by inspection of `strip.ts:33-83`.

**Recommendation.** None. Document-as-non-issue.

### MISSED-3 / Severity: Info / Adapter correctness — struct tags / `strip.ts:55-62`

**What.** Go struct tags (the metadata strings between fields
and their types in struct declarations) are syntactically
just raw strings: `` Name string `json:"name"` ``. The
scanner treats them identically to any other backtick raw
string, which is correct. The user prompt called these out
as a Go-specific concern; they are handled by the existing
backtick branch. Confirmed non-issue.

**Why.** Struct tags have no special syntactic role from the
lexer's perspective — they're just raw strings whose content
is parsed by `reflect.StructTag` at runtime. The lexer's job
is to mark the region; the strip is correct.

**Recommendation.** None. Document-as-non-issue.

## Overall

The package is in materially better shape than 24 hours ago.
Wave 1 closed F2 (substantially), F4 (cleanly via core
delegation + test pinning), F5 (mostly), and F6 (cleanly).
The remaining work is small: F1 is a one-line typing fix; F3
is a one-line doc comment; the two MISSED-1 tests are ~12
lines combined. NN-3 is a one-line import cleanup that should
be applied across the lang-* tier in one sweep.

NN-1 (Phase-2 driver extraction) is correctly deferred —
"three identical implementations is the pattern line" but the
trigger condition (a fifth token in any pack, or a seventh
language pack) hasn't fired yet.

Layering is clean (`lang-go → core` only, verified against
`.dependency-cruiser.cjs`); SRP is good (four files, one
concern each — `index` re-exports, `adapter` declares,
`parse` builds the text tree, `strip` runs the lexer);
DIP is followed (no concrete coupling to siblings — only
contract types from core); Adapter pattern is correctly
applied (the `LanguageAdapter<GoTree>` interface is the seam,
`goAdapter` is the concrete subject). No GoF anti-patterns.
No new SOLID violations.

**Priority queue for the next pass:**

1. F1 — narrow `parseGo` return type to `GoTree` (1 line).
2. NN-3 — switch `adapter.ts` to barrel import for
   `LanguageAdapter` (1 line). Apply to lang-java/cpp/rust/python.
3. MISSED-1 — add two regression tests (~12 lines).
4. F3 — add `\r`-discard `@todo` doc comment (1 line).
5. NN-1 — defer; revisit when lang #7 lands or any pack grows
   a fifth token.
