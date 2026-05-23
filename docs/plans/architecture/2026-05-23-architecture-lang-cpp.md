---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/lang-cpp"
package: "@opensip-tools/lang-cpp"
audience: [contributors, architects]
supersedes: 2026-05-22-architecture-lang-cpp.md
---
# Architecture audit (delta) — @opensip-tools/lang-cpp

Delta against `2026-05-22-architecture-lang-cpp.md`. Wave 1 (`d92bbb7`)
landed lexer fixes for the line-splice and `u8'` issues; the C-family
scaffolding adoption (`3d65016`) replaced byte-identical scanners with
calls into `core/languages/strip-utils.ts`; alias canonicalisation
(`fd178f1`) closed the scope-matching trap.

## Status of prior findings

### F1 — Aliases advertised but only used for warning path
- **Status:** **CLOSED.**
- **Verification:** `LanguageRegistry.canonicalize()` exists at
  `packages/core/src/languages/registry.ts:115-119`, populated alongside
  `byId` via `indexAliases` (`registry.ts:59-91`). `findByScope` in
  `packages/fitness/engine/src/targets/target-registry.ts:97-118`
  canonicalises both sides through `toCanonical` (line 25-27).
  `defineCheck` in
  `packages/fitness/engine/src/framework/define-check.ts:226-241`
  rewrites `scope.languages` to canonical ids before storing them on
  the check. A target written `languages: ['c']` now matches a check
  scoped to `cpp`.

### F2 — One adapter folds C and C++ together
- **Status:** **OPEN, deferred.**
- **Verification:** `cppAdapter.id === 'cpp'`, `aliases: ['c', 'c++']`
  (`adapter.ts:15-17`). `checks-cpp` still ships exactly one check
  (`clang-tidy-passthrough.ts`), so the prior recommendation to defer
  splitting until a second check arrives still holds.

### F3 — Preprocessor and line-continuation handling absent
- **Status:** **PARTIALLY CLOSED.** Line splice in `//` comments is
  fixed; broader preprocessor masking remains an explicit non-goal.
- **Verification:** `strip.ts:46-52` calls
  `scanLineComment(src, i, { allowLineContinuation: true })`. The
  helper at `core/languages/strip-utils.ts:156-176` checks
  `src[i-1] === '\\'` immediately before each `\n` and continues. Test
  `cpp stripComments line-continuation (F3)` at
  `__tests__/adapter.test.ts:97-126` covers spliced and non-spliced
  forms. `strip.ts:12-17` documents that `#if 0` masking, macro splices
  outside `//`, and full phase-2 splicing across all token types remain
  out of scope.

### F4 — Scanner duplication across lang-cpp / lang-java / lang-go
- **Status:** **CLOSED.** Adopted in `3d65016`.
- **Verification:** `strip.ts:19-26` imports `applyRegions`,
  `scanBlockCommentNonNesting`, `scanCharLiteral`, `scanLineComment`,
  `scanRegularString`, `Region` from the core barrel. The line/block
  comment loops collapsed to `scanLineComment` (line 48) and
  `scanBlockCommentNonNesting` (line 57). Char-literal scanning is now
  delegated to `scanCharLiteral` (line 124). The package no longer
  ships its own copies of these scanners.

### F5 — `u8'` char prefix and unbounded char-literal scan
- **Status:** **CLOSED.** Both subitems landed in `d92bbb7`.
- **Verification:** `matchCharLiteralPrefix` at `strip.ts:159-164`
  recognises `'`, `L'`, `u'`, `U'`, and `u8'`; the `u8'` branch is
  ordered before the `u'` branch as the comment notes. The 8-char cap
  is gone — `scanCharLiteral` is invoked with `maxScan: 12`
  (`strip.ts:124`), enough for `'\u{1F600}'`. Tests at
  `__tests__/adapter.test.ts:66-94` cover both fixes including the
  unicode escape case.

### F6 — `parse: () => null` is correct but the contract should make it
explicit
- **Status:** **OPEN.** No change. `LanguageAdapter.parse` at
  `core/languages/adapter.ts:34` is still required and JSDoc still
  conflates "I tried and failed" with "I do not parse". `cppAdapter`
  still uses `parse: () => null` (`adapter.ts:18`). Recommendation
  unchanged: make `parse` optional on the interface and have callers
  guard on `adapter.parse`.

## NET-NEW findings

### F7 — `scanCharLiteral` exposes an `openChars` option that is never read
- **Severity:** Low (interface smell, not a runtime bug).
- **Where:** `packages/core/src/languages/strip-utils.ts:253-271,
  289-332`. The option is also documented in lang-cpp's call site
  comment at `strip.ts:116-123`.
- **What:** `ScanCharLiteralOptions.openChars` is declared and
  documented as "the set of characters that may open this literal,
  defaults to `["'"]`", but nothing in the function body reads it. The
  scanner unconditionally treats `start` as the position of an
  apostrophe — every caller (lang-cpp, lang-java) already strips the
  language-specific prefix before invoking.
- **Why:** Interface-Segregation Principle and YAGNI. The option
  advertises a capability the helper does not have; a future caller
  that passes `openChars: ['"']` (intending a string-literal-shaped
  scanner) would silently get wrong behaviour. This is the same class
  of smell as F1 was for `aliases`: a public field that looks like it
  means something it does not.
- **Recommendation:** Either delete the field (recommended — every
  current caller works without it) or implement it (the body
  conditionalises `ch === "'"` on `openChars.includes(ch)`). Lang-cpp
  is downstream and only consumes `maxScan`, so this is a core-side
  fix; flagged here because lang-cpp's call-site comment cites the
  option.

### F8 — Char-literal cap moved from 8 to 12 in lang-cpp but the helper
default remains 8
- **Severity:** Low (papered-over divergence, not a bug today).
- **Where:** `strip.ts:124` passes `{ maxScan: 12 }`.
  `core/languages/strip-utils.ts:266-271, 294` defaults to 8.
- **What:** The helper's docstring still describes the 8-cap as
  "matches the lang-cpp / lang-java / lang-rust heuristic"
  (`strip-utils.ts:265-268`), but lang-cpp now needs 12 to handle
  `'\u{1F600}'`-shaped UCN escapes. Lang-java still uses the default 8;
  whether Java's `'\uD83D'`-style escape (which is exactly 8 chars
  including quotes) ever overflows the default 8 cap depends on caller
  prefix-stripping. The "single source of truth" the helper claims is
  no longer true.
- **Why:** Open/Closed Principle. The helper's docstring claims a
  shared heuristic; the call sites disagree. A maintainer reading the
  helper alone would miss that lang-cpp's effective bound is 12, and
  any future char-literal addition (e.g. raw char literals if C++26
  adopts them) would need to know which cap to inherit.
- **Recommendation:** Move the cap into a named constant — e.g.
  `DEFAULT_CHAR_LITERAL_CAP = 12` — exported from `strip-utils.ts`,
  and have lang-cpp / lang-java reference it (or accept the default).
  Update the docstring to reflect that the bound must accommodate
  C/C++ universal-character-name escapes. Alternative: make the cap
  language-aware by introducing per-language presets in core.

### F9 — Inconsistent import style: subpath in `adapter.ts`, barrel in
`strip.ts`
- **Severity:** Low (style consistency, layering rule already
  satisfied).
- **Where:** `adapter.ts:3` —
  `import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'`.
  `strip.ts:19-26` — `import { applyRegions, ... } from '@opensip-tools/core'`.
- **What:** CLAUDE.md says "Subpath exports are strongly discouraged;
  prefer the package barrel." `LanguageAdapter` is re-exported from the
  barrel (`core/src/index.ts:6` re-exports `./languages/index.js`,
  which exports `LanguageAdapter` at line 1). `adapter.ts` could (and
  per CLAUDE.md should) drop the subpath. The two files in the same
  package using two different import styles is a small consistency
  smell.
- **Why:** Code-base norms. A new contributor cargo-culting either
  file gets a different answer about the right way to import core
  types.
- **Recommendation:** Rewrite `adapter.ts:3` as
  `import type { LanguageAdapter } from '@opensip-tools/core'`. Trivial
  edit, no behaviour change.

### F10 — `scan()` cognitive-complexity suppression survived the
refactor; complexity itself dropped
- **Severity:** Low (housekeeping).
- **Where:** `strip.ts:33` —
  `// eslint-disable-next-line sonarjs/cognitive-complexity`.
- **What:** Before `3d65016`, the `scan()` function inlined four token
  scanners and the suppression was load-bearing. After the refactor,
  the body collapses to a dispatch over `matchRawStringPrefix /
  matchStringPrefix / matchCharLiteralPrefix` and short calls into
  helpers; cyclomatic complexity is materially lower. The suppression
  is now likely no longer required by the rule's threshold.
- **Why:** Suppressions accumulate. The original rationale ("token
  state machines have inherent complexity") is correct in general but
  the specific threshold trip is an ESLint implementation detail that
  changes when the body shrinks.
- **Recommendation:** Try removing the `eslint-disable` line. If
  `pnpm lint` still passes, leave it removed. If it doesn't, restore
  with a one-line note pointing to the helpers that absorbed the rest
  of the complexity.

### F11 — `c++` alias is a YAML quoting footgun
- **Severity:** Very low.
- **Where:** `adapter.ts:17` — `aliases: ['c', 'c++']`.
- **What:** `'c++'` round-trips fine through the alias index, but
  YAML users who write `languages: [c++]` unquoted get a parse error;
  quoted (`'c++'`) it works. `'c'` already covers the common case.
- **Why:** Least surprise.
- **Recommendation:** Drop `'c++'`; document that `cpp` is canonical
  and `c` is the convenience alias.

## MISSED — issues the prior audit did not flag

### F12 — Identifier-prefix collisions in `matchStringPrefix` /
`matchCharLiteralPrefix` are unanchored
- **Severity:** Low (rare in practice, but a stripping correctness
  hole).
- **Where:** `strip.ts:98-107` (regular-string branch) and
  `strip.ts:113-127` (char-literal branch). Both prefix matchers
  (`matchStringPrefix`, `matchCharLiteralPrefix`) look only at
  `src[i+N]` without any check that `src[i-1]` is a non-identifier
  character.
- **What:** In source like `auto x = abcL"foo";` (legal in older C++
  via macro pasting and not uncommon in third-party headers), the
  scanner walks from `a` → `b` → `c` → `L`. At `L`, `matchStringPrefix`
  returns 1, `src[i+1] === '"'` → enters string scan and strips
  `foo`. The same trap exists for `u8`, `u`, `U`, `R`, and the char
  prefixes. For string stripping the outcome is benign — the
  characters between the quotes ARE a string literal — but for any
  check that consumes `stripStrings` output and then expects to find
  the *raw identifier* `abcL` in the stripped source, the result is
  correct (only `foo`'s bytes are blanked, `abcL` survives). The
  actual risk is on the char-literal branch: `nameL'a'` would be
  consumed as `L'a'` (3 bytes), advancing past the apostrophe pair —
  but since char literals are preserved as code, the output is still
  byte-identical to the input. Net effect: no observed corruption,
  but the scanner is doing work it shouldn't.
- **Why:** Correctness-by-coincidence. Today the strip operations
  happen to produce the right output even when the prefix matcher
  fires inside an identifier, because (a) string content is what we
  want to blank, and (b) char literals are preserved. Any future
  check that asks "where are the string literals?" via region
  positions would get false positives. Lang-java (audit F2 in its
  prior delta) flagged the analogous trap.
- **Recommendation:** Add a one-line guard inside
  `matchStringPrefix` and `matchCharLiteralPrefix`: return 0 / -1
  unless `i === 0` or `src[i-1]` is not in `[A-Za-z0-9_]`. Same fix
  pattern as lang-java's tokeniser. Cheap, prevents future surprises.

### F13 — Trigraph and digraph awareness absent
- **Severity:** Very low (deprecated in C++17, removed in C++23; still
  legal in C).
- **Where:** No handling anywhere in `strip.ts`.
- **What:** Trigraphs (`??=`, `??/`, `??<`, etc.) are translated in
  phase 1 to `#`, `\`, `{`, etc. before any other lexing. `??/`
  becoming `\` is the sharp edge — at the end of a line it forms a
  line splice. Digraphs (`<:`, `:>`, `<%`, `%>`, `%:`, `%:%:`) remain
  legal and compile in modern C++ but are pure punctuation aliases,
  no lexing impact.
- **Why:** Completeness. The prior audit's F3 mentioned phase-2
  splicing but did not call out phase-1 trigraph translation.
- **Recommendation:** Document — not implement. Add a sentence in the
  `strip.ts` leading comment that trigraphs are not handled (deprecated
  in C++17, modern code does not use them, supporting them would mean
  doing phase-1 translation before any lex, which is outside the
  best-effort contract). Same disposition as the broader preprocessor
  question.

## Overall assessment

`@opensip-tools/lang-cpp` is in materially better shape than at the
prior audit. Three of the six prior findings (F1, F4, F5) are fully
closed; F3 is closed for the case that mattered (line splice in `//`)
with the broader preprocessor question explicitly out-of-scope. F2
and F6 remain open by design — F2 waiting on a second check to
justify the C/C++ split, F6 a kernel-level interface change that
benefits more than just lang-cpp.

The package now lives within the C-family scaffolding contract: it
imports six helpers from `@opensip-tools/core`, owns only the
language-specific dispatch (raw-string + prefix matchers + char-prefix
matcher), and ships ~175 lines of source. Layering is clean — no
imports outside `@opensip-tools/core`, no peer-package coupling.

The new findings are housekeeping: the `openChars` dead option (F7),
a divergence between the helper's documented `maxScan` heuristic and
lang-cpp's effective cap (F8), an import-style inconsistency (F9), a
suppression that may no longer be needed (F10), and a stale alias
entry (F11). The one previously-missed correctness issue (F12,
unanchored identifier prefix matching) is benign today but worth
fixing while the analogous lang-java fix is fresh in the contributor
mental model.

No SOLID red flags. The Adapter pattern is intact. SRP is well
served by the strip / parse / adapter split. DIP is satisfied:
lang-cpp depends on the abstract `LanguageAdapter` contract from core,
not on any peer pack or downstream check. The file at the top of the
delta plan (Layer 3 Phase B1) is closed for this package.
