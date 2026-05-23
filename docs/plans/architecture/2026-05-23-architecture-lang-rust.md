---
status: current
last_verified: 2026-05-23
title: "Architecture audit — @opensip-tools/lang-rust (delta)"
package: "@opensip-tools/lang-rust"
audience: [contributors, architects]
supersedes: 2026-05-22-architecture-lang-rust.md
---
# Architecture audit — @opensip-tools/lang-rust (delta)

## Context — what changed since 2026-05-22

Wave 4 (commit `3d65016`, "refactor(lang-*): adopt core's C-family lexer
scaffolding") collapsed lang-rust onto the shared core helpers
(`scanLineComment`, `scanBlockCommentNesting`, `scanRegularString`,
`buildMinimalTextTree`). `parse.ts` shrank from 23 → 23 LOC but is now a
one-line delegate; `strip.ts` shrank from ~270 → 177 LOC by deleting the
private `scanRegularString` and a redundant escape-elaboration. Net source
size for the package is now ~220 LOC across four files; tests
unchanged at ~340 LOC across three files.

The Wave 4 trade-off lang-rust uniquely accepts: it does NOT adopt
core's `scanCharLiteral` helper. The inline char-vs-lifetime branch in
`strip.ts:121-159` is preserved because lang-rust needs the
"no close found" position to fall through to the lifetime path, while
core's `scanCharLiteral` collapses overflow into "advance one past the
opener" — semantically identical for lang-cpp / lang-java but it loses
the information lang-rust uses to commit the lifetime case. The decision
is documented in a code comment (lines 128-133), which closes the F2
"add a doc comment" recommendation in passing.

## Status of prior findings

### F1 — Privately-duplicated `scanRegularString` — **CLOSED**

Wave 4 added `{ allowMultiline?: boolean }` to core's
`scanRegularString` (`strip-utils.ts:65-117`) and lang-rust now calls it
with `allowMultiline: true` for both regular strings (`strip.ts:112`)
and byte strings (`strip.ts:104`). The local copy is gone. The
recommendation in the prior audit was carried out exactly as stated.

### F2 — Char-vs-lifetime heuristic doc comment — **CLOSED**

`strip.ts:128-133` now documents the look-ahead window and explains why
core's `scanCharLiteral` is intentionally not used here. The 8-char
window is also formalized in core's
`ScanCharLiteralOptions.maxScan` default (`strip-utils.ts:270`), so the
two heuristics are aligned even though lang-rust doesn't share the
function body. The "tighten the EOF test to assert `out === src`"
optional sub-recommendation is unaddressed but remains optional.

### F3 — `parse()` `null` return path is unreachable — **OPEN (cosmetic)**

The file-header in `parse.ts:1-15` was rewritten in Wave 4 and now
mentions that the future tree-sitter parser may grow real failure paths
("the adapter contract is unchanged — only the RustTree shape grows"),
but it does not call out that consumers should be prepared to handle
`null`. The cosmetic recommendation from the prior audit is unmet.
Severity unchanged (cosmetic).

### F4 — `RustTree` shape duplicates an unwritten `MinimalTextTree` — **CLOSED**

`packages/core/src/languages/text-tree.ts` now exports a shared
`MinimalTextTree` interface and `buildMinimalTextTree()` factory.
`parse.ts:19` declares `export type RustTree = MinimalTextTree`, exactly
as the prior audit recommended (the optional brand suffix `& { _tag:
'RustTree' }` was not adopted, but the prior audit explicitly marked the
brand as optional). All five MVP packs share the same factory, so
divergence is now type-system-detectable.

### F5 — Public surface area in `index.ts` wider than needed — **OPEN (deferred)**

`index.ts:1-3` is unchanged. The prior audit explicitly deferred this
to a major release, so "open" is the expected state. No action.

### F6 — Disabled `sonarjs/cognitive-complexity` should reference the core
extension plan — **PARTIALLY CLOSED**

The local `scanRegularString` was deleted, so its suppression is gone.
The remaining suppression on `scan` (`strip.ts:29`) still has the
"cyclomatic complexity is inherent to lexer-style scanners" rationale.
This matches the prior audit's recommendation ("leave the suppression
on `scan` with the existing rationale") so this is effectively closed.

---

## NET-NEW findings

### N1 — Severity: low — Byte-string strip does not enforce ASCII-only contents

- **Where:** `strip.ts:101-108` (byte-string call-site); file-header
  `strip.ts:9`.
- **What:** Byte strings disallow non-ASCII source bytes in real Rust;
  `b"…<UTF-8 multi-byte>"` is a parse error. The current scanner
  happily strips the multi-byte sequence and continues. Length is
  preserved and bytes are opaque to the lexer, so this is fine for
  stripping. The file-header claims "Byte strings (b"...")" support
  without noting that strict byte-string syntax is not enforced.
- **Why it matters:** A future check that wants to flag invalid byte
  literals will see all `b"…"` content collapsed identically to a
  regular string post-strip.
- **Recommendation:** No code change. Add a one-line note to the
  `strip.ts` file-header: "Byte-string content is treated as opaque
  bytes; this layer does not enforce the ASCII-only / valid-escape
  rules of `b"…"`."

### N2 — Severity: low — Raw-string and byte-string detection ignore preceding word-boundary context

- **Where:** `strip.ts:60-99` (raw / byte-raw branch),
  `strip.ts:101-108` (byte-string branch).
- **What:** The lexer enters the raw-string branch on `r"`, `r#`, `br"`,
  or `br#` regardless of what precedes the `r` or `b`. Real Rust treats
  these prefixes as keywords only at token boundaries: `foo_r"hi"` is
  not a raw string; it's a syntax error after the identifier `foo_r`.
  Today the lexer would happily strip `"hi"` as a raw-string body. This
  also applies to the byte-string branch — `barr"hi"` (illegal) gets
  raw-stripped from the second `r`. None of the peer C-family adapters
  (lang-cpp, lang-java, lang-go) track word boundaries either, so this
  is a family-wide convention rather than a regression.
- **Why it matters:** Any check that runs against malformed source (e.g.
  partial files, code in markdown fences, work-in-progress edits) may
  see strings stripped that should not have been. Length-preservation
  invariants still hold, so the worst-case is a check missing a
  finding rather than producing a wrong location.
- **Recommendation:** No code change in lang-rust alone — fixing this
  here without doing the same in lang-cpp / lang-java / lang-go would
  desync the family. If the broader team wants to harden this, the right
  move is to add an `isIdentChar(prev)` guard to a future
  `scanRawString` core helper (currently inlined per-pack) so all four
  packs adopt it together. File this as a "family-level enhancement"
  rather than a per-pack finding.

### N3 — Severity: very low — Diverged char-literal heuristics between lang-rust and lang-cpp/lang-java

- **Where:** `strip.ts:121-159` (lang-rust inline);
  `packages/languages/lang-cpp/src/strip.ts:124` (uses
  `scanCharLiteral` with `maxScan: 12`);
  `packages/languages/lang-java/src/strip.ts:119` (uses
  `scanCharLiteral` with default `maxScan: 8`);
  `packages/core/src/languages/strip-utils.ts:289-332` (helper).
- **What:** Wave 4 unified char-literal handling in lang-cpp and
  lang-java behind core's `scanCharLiteral`. Lang-rust deliberately did
  not migrate, because it needs to distinguish "no close in window"
  (lifetime) from "char literal closed". Looking at core's helper
  (`strip-utils.ts:325-331`), the API actually does provide that
  information — it returns `end: start + 1` on overflow (advance past
  the apostrophe alone) vs `end: j` on success (advance past the close).
  The two are distinguishable because the success path always returns
  `end > start + 1`.
- **Why it matters:** The justification comment at `strip.ts:130-133`
  ("scanCharLiteral helper bails on overflow rather than reporting the
  'no close found' position") is technically inaccurate in its current
  form: core's helper *does* report a distinguishable result. Lang-rust
  *could* migrate to `scanCharLiteral` and check `result.end ===
  i + 1` as the lifetime branch. The migration would delete ~30 lines
  and let the family share one heuristic. The trade-off is that the
  inline version uses a literal `for` loop with explicit `escape`
  state which is arguably more readable for the Rust-specific
  edge cases the test suite exercises.
- **Recommendation:** Optional refactor — replace the inline branch
  with `scanCharLiteral(src, i)` and treat `result.end === i + 1` as
  "lifetime; advance 1". Keep the existing test cases — they should pass
  unchanged. If kept inline, fix the comment at lines 130-133 to
  accurately describe core's helper ("would work, but the inline form
  keeps the lifetime branch decision local to the lexer state machine").

### N4 — Severity: very low — `scan()` returns shallowly-readonly `Region[]`s

- **Where:** `strip.ts:24-27`.
- **What:** `Scan` declares `readonly stringRegions: Region[]` — the
  array *slot* is readonly but the array contents are not. Other lang-*
  packs share the shape. No real bug: callers spread the arrays into
  `applyRegions` which takes `readonly Region[]`.
- **Recommendation:** No per-pack action. Family-level sweep to
  `ReadonlyArray<Region>` if desired.

---

## MISSED findings (things the 2026-05-22 audit didn't catch)

### M1 — Severity: low — Wave 4 made `parseRust`'s `| null` provably dead

- **Where:** `parse.ts:21-23`.
- **What:** Wave 4 replaced the inline body with a single delegate to
  `buildMinimalTextTree`, which never returns null. Prior F3 framed the
  null path as a *forward-looking* concern; Wave 4 made it concretely
  dead today. The `| null` is required for `LanguageAdapter` contract
  conformance (`core/languages/adapter.ts`).
- **Recommendation:** Add a JSDoc on `parseRust`: "Returns `RustTree`;
  the `| null` in the signature is for `LanguageAdapter` contract
  conformance and will become reachable when tree-sitter lands."
  Superset of prior F3.

### M2 — Severity: very low — Test for raw-string ambiguity asserts identity, but only on inputs without quotes

- **Where:** `__tests__/strip.test.ts:53-65`.
- **What:** The two `r ambiguity` tests use inputs like `let r###` and
  `fn foo() { r##xyz }`. They correctly verify the lexer doesn't
  hang or crash, and that `out === src` (no stripping occurred). What
  is *not* covered: the case where `r` is used as a single-char
  identifier followed by a normal string literal — e.g.
  `let r = "hi"`. That input *should* strip the `"hi"` body. The lexer
  handles it correctly because `next === ' '` (space), so it doesn't
  enter the raw-string branch. But the test suite has no assertion
  that confirms this happy path through the disambiguation logic.
- **Why it matters:** A future refactor of the raw-string branch
  guard (e.g. relaxing `next === '"' || next === '#'` to `next !== ' '`)
  would silently start treating `let r =` as the start of a raw string
  with `=` as the opener. The current test suite would not catch this.
- **Recommendation:** Add one test:
  ```ts
  it('treats a bare `r` identifier followed by a string normally', () => {
    const src = 'let r = "hi";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hi')
    expect(out).toContain('let r =')
  })
  ```

### M3 — Severity: very low — `parseRust` accepts empty `filePath` without diagnostics

- **Where:** `parse.ts:21-23`; `core/languages/text-tree.ts:47-53`.
- **What:** `parseRust('content', '')` succeeds with `filePath: ''`.
  Family-wide non-validation; cosmetic.
- **Recommendation:** No action.

---

## Layering / DIP conformance

Imports in `src/`:

- `adapter.ts:5` — `import type { LanguageAdapter } from
  '@opensip-tools/core/languages/adapter.js'`
- `parse.ts:17` — `import { buildMinimalTextTree, type MinimalTextTree
  } from '@opensip-tools/core'`
- `strip.ts:16-22` — `import { applyRegions, scanBlockCommentNesting,
  scanLineComment, scanRegularString, type Region } from
  '@opensip-tools/core'`

All three workspace imports terminate at `@opensip-tools/core`. No
imports from fitness, simulation, contracts, cli, checks-*, or sibling
lang-* packs. The `package.json` dependencies field
(`packages/languages/lang-rust/package.json:30-32`) declares only
`@opensip-tools/core: workspace:*`. Layering is clean and
dependency-cruiser rules at `.dependency-cruiser.cjs:225-243`
constrain this correctly.

## Adapter contract conformance

`rustAdapter` (`adapter.ts:7-14`) supplies `id`, `fileExtensions`,
`aliases`, `parse`, `stripStrings`, `stripComments`. The optional
`query` field is omitted (correct for an MVP without tree-sitter). The
`adapters` plugin contract (`adapter.ts:17`) is the standard `as const`
tuple. No deviations from the family shape.

## Overall assessment

Lang-rust came through Wave 4 cleanly. Of six prior findings, F1 and
F4 are fully closed by code change; F2 is closed by documentation; F3
and F5 remain open as documented; F6 is partially closed by deletion.
The package is now ~220 LOC of source, all of it domain-meaningful — a
single state-machine in `strip.ts`, a delegate in `parse.ts`, and a
contract object in `adapter.ts`. The four NET-NEW findings (N1-N4) are
all low or very-low severity and several are family-level rather than
lang-rust-specific. The three MISSED findings (M1-M3) are cosmetic. No
SOLID, DIP, or layering violations were found. The `scanCharLiteral`
non-adoption (N3) is the most interesting open question, and the
right answer there is probably "leave it inline and fix the
justification comment" rather than refactor for refactor's sake.

The package's stability — across two audits and a major refactor — is
itself the headline. Adapters that stay this small and this disciplined
are doing their job.
