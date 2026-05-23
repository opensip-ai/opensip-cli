---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/lang-python"
package: "@opensip-tools/lang-python"
audience: [contributors, architects]
prior_audit: 2026-05-22-architecture-lang-python.md
---
# Architecture audit (delta) — @opensip-tools/lang-python

Delta audit dated 2026-05-23. Prior audit: `2026-05-22-architecture-lang-python.md`.

Two changes have landed since the prior audit:

1. **Wave 1 lexer fix** (commit `b900843`, "fix(lang-python): correct
   raw-string backslash-quote handling") — `matchStringStart` no longer
   returns `isRaw`; `scanSingleString` / `scanTripleString` no longer
   take an `isRaw` flag; `\<anything>` advances 2 chars unconditionally;
   nine new tests added.
2. **C-family scaffolding adoption** (commit `3d65016`,
   "refactor(lang-\*): adopt core's C-family lexer scaffolding") — moved
   `lang-cpp/-go/-java/-rust` onto `core/languages/strip-utils.ts` and
   `core/languages/text-tree.ts`. **lang-python was deliberately NOT
   migrated** in that commit. The Python lexer still owns its own
   `Region`/`applyRegions` import and its own `parsePython` body that
   inlines `buildLineStarts` rather than delegating to
   `buildMinimalTextTree`. This is the largest delta worth examining.

## Status of prior findings

| ID | Title | Severity | New status |
|----|-------|----------|------------|
| F1 | Raw-string quote-escape divergence from CPython | Minor correctness | **CLOSED** |
| F2 | `""""""` vs `"" ""` disambiguation lacks coverage | Working-as-intended | **CLOSED** |
| F3 | `parse.ts` is the same MVP shim as four siblings (extraction candidate) | Cosmetic | **PARTIALLY CLOSED — see NN1 below** |
| F4 | `scanSingleString` newline-recovery undocumented vs siblings | Cosmetic | **OPEN — no tests added** |
| F5 | `parse()` never returns `null` despite contract permitting it | Working-as-intended | **OPEN (out-of-scope: belongs to consumers)** |
| F6 | `query` not implemented — graceful, but documents nothing | Working-as-intended | **OPEN — no docblock note added yet** |

### F1 — verified CLOSED

`packages/languages/lang-python/src/strip.ts` lines 66–103 (matchStringStart),
111–141 (scanTripleString), 143–179 (scanSingleString). Three confirmations:

- `matchStringStart` returns only `{ quoteIndex }` — no `isRaw` field
  (line 69). The function header comment (lines 59–65) explicitly cites
  the CPython rule and explains why raw-vs-non-raw is irrelevant for
  tokenization-bound work.
- Both scan functions advance 2 on backslash unconditionally
  (`scanTripleString` lines 120–132; `scanSingleString` lines 159–171),
  with the CPython quote rule documented inline.
- Nine regression tests in `__tests__/adapter.test.ts` lines 106–195
  cover `r"\""`, `r'\''`, `r"\\"`, `r"\n"`, `rb"\""` and the
  triple-raw `r"""\""""`, plus the negative-control `+ "tail"` suffix
  to prove the scanner did not leak past the literal.

The fix is complete and the test set is the right shape (each case
asserts both `not.toContain('tail')` and a structural marker in the
preserved code).

### F2 — verified CLOSED

`__tests__/adapter.test.ts` lines 197–225 (three tests under
"disambiguation: empty triple-string vs paired empty strings") pin
`x = """"""` (one empty triple), `x = ''''''` (single-quote variant),
and `x = "" ""` (two empty strings, whitespace-separated). The
greedy-triple semantics in `strip.ts` line 205 are now safe to
refactor without regressing CPython parity.

### F3 — partially CLOSED

The companion C-family packs (`lang-cpp`, `-go`, `-java`, `-rust`)
collapsed their `parse.ts` to one-line `buildMinimalTextTree`
delegations under commit `3d65016`. Each is now 23 lines, e.g.
`lang-rust/src/parse.ts` lines 17–22:

```ts
import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'
export type RustTree = MinimalTextTree
export function parseRust(content, filePath): RustTree | null {
  return buildMinimalTextTree(content, filePath)
}
```

`lang-python/src/parse.ts` did not migrate. Lines 14, 22–28 still
inline `buildLineStarts`:

```ts
import { buildLineStarts } from '@opensip-tools/core'
export interface PythonTree {
  readonly source: string
  readonly filePath: string
  readonly lineStarts: readonly number[]
}
export function parsePython(content, filePath): PythonTree | null {
  return { source: content, filePath, lineStarts: buildLineStarts(content) }
}
```

`PythonTree` is structurally identical to `MinimalTextTree` (same three
fields, same readonly modifiers — see
`packages/core/src/languages/text-tree.ts` lines 28–40). The original
F3 recommendation was "leave it duplicated" because each pack would
diverge under tree-sitter. The C-family decided otherwise: collapse to
the shared factory now, knowing each pack will replace its own `parse()`
when tree-sitter lands. lang-python is now the sole holdout. See NN1.

### F4 — OPEN

The scanSingleString newline-recovery semantics still lack the two
suggested regression tests (line continuation `\\<newline>`,
unterminated-before-newline). Source unchanged at lines 156–158.
Cosmetic, no urgency, but the recommendation stands.

### F5, F6 — OPEN

No source change required by either; both depend on follow-up work
elsewhere (consumers of `adapter.parse()` for F5; a docblock or README
note for F6). Restating prior recommendation; not a delta.

## Net-new findings

### NN1 — `parse.ts` did not adopt `buildMinimalTextTree` alongside its C-family siblings

- **F#:** NN1
- **Severity:** Minor (consistency / DRY)
- **Where:** `packages/languages/lang-python/src/parse.ts` lines 14, 22–28
  vs `packages/core/src/languages/text-tree.ts` lines 28–53 and
  `packages/languages/lang-rust/src/parse.ts` lines 17–22
  (representative sibling).
- **What:** Commit `3d65016` migrated `lang-cpp`, `-go`, `-java`, and
  `-rust` to delegate `parse()` to `core.buildMinimalTextTree` and to
  alias their per-language `XTree` to `MinimalTextTree`.
  lang-python's `parse.ts` still constructs the triple by hand
  (`{ source, filePath, lineStarts: buildLineStarts(content) }`) and
  declares `PythonTree` as a fresh interface rather than a brand alias
  over `MinimalTextTree`.
- **Why it matters:** The three fields and readonly modifiers in
  `PythonTree` are byte-equivalent to `MinimalTextTree`. The prior audit
  (F3) argued for keeping the duplication on the grounds that each pack
  would diverge under tree-sitter — but the C-family decided that the
  brand-alias pattern handles divergence cleanly: when Python grows a
  real tree-sitter tree, `PythonTree` simply stops aliasing
  `MinimalTextTree` and grows its own shape, exactly like the others.
  Today's status leaves lang-python as the lone outlier in a
  five-pack family. The cost of staying out is small (5 extra lines)
  but it creates two minor drag effects:
    1. A future contributor reading `lang-typescript`, `-rust`, `-go`,
       `-java`, `-cpp`, `-python` in order will see a five-of-six
       pattern and assume the sixth is wrong, opening a churn PR.
    2. If `MinimalTextTree` grows a field (e.g. a precomputed
       byte-offset cache), Python silently drops the field and
       `MinimalTextTree`-shaped checks that target Python via duck-typed
       access will silently work in TS but produce different runtime
       behavior — exactly the kind of low-grade rot the brand-alias
       pattern was introduced to prevent.
- **Recommendation:** Migrate `parse.ts` to the same shape as the four
  C-family siblings. Concretely:

  ```ts
  import { buildMinimalTextTree, type MinimalTextTree } from '@opensip-tools/core'
  export type PythonTree = MinimalTextTree
  export function parsePython(content: string, filePath: string): PythonTree | null {
    return buildMinimalTextTree(content, filePath)
  }
  ```

  The named `PythonTree` brand keeps the adapter generic-parameter name
  distinct (`LanguageAdapter<PythonTree>`), so `adapter.ts` line 7 is
  unchanged. No external consumer of `index.ts` line 2's `PythonTree`
  re-export sees a behavior change. This supersedes the prior F3
  "leave it duplicated" recommendation — the family voted with their
  feet.

### NN2 — Strip pass is the only sibling that does not consume any core scaffolding

- **F#:** NN2
- **Severity:** Cosmetic / future-proofing observation, NOT a refactor
  recommendation.
- **Where:** `packages/languages/lang-python/src/strip.ts` line 20
  (only imports `applyRegions, type Region` from core);
  `packages/core/src/languages/strip-utils.ts` exports
  `scanRegularString`, `scanLineComment`, `scanBlockCommentNonNesting`,
  `scanBlockCommentNesting`, `scanCharLiteral`.
- **What:** lang-python's strip pass uses none of the new C-family
  scaffolding helpers, while every other pack uses at least two. This
  is **correct** for the reasons the prior audit's "non-findings"
  section already laid out: Python's strings can open with `'` or `"`,
  have eight ASCII prefix forms, and use `#` line comments — none of
  which fit the C-family helper signatures.
- **Why it matters:** Worth recording explicitly so the next reviewer
  doesn't propose forcing `scanRegularString` (hard-coded to `"`) onto
  Python's lexer. The right escalation, if it ever becomes worthwhile,
  is to lift a parameterized `scanQuotedString(quoteChar)` into core —
  but only if a second adopter (Ruby, Bash, Swift) appears. With one
  consumer it stays in `lang-python`.
- **Recommendation:** Add a one-line note to `strip.ts`'s header
  docblock (anywhere near lines 1–18) clarifying that this pack
  intentionally does not use `core/languages/strip-utils.ts`'s
  C-family scanners because Python's quote rules don't fit. No source
  change beyond the comment.

### NN3 — `index.ts` no longer needs to re-export `parsePython` if NN1 lands

- **F#:** NN3
- **Severity:** Trivial / dependent on NN1.
- **Where:** `packages/languages/lang-python/src/index.ts` line 2.
- **What:** Today `index.ts` re-exports `parsePython` and the
  `PythonTree` type. The C-family siblings' index files re-export
  the same pair. If NN1 lands and `PythonTree` becomes a brand alias,
  the re-export is unchanged (still works), but the package's public
  surface effectively becomes `LanguageAdapter<MinimalTextTree>`.
  Worth verifying that no downstream check pack imports
  `parsePython` directly — they should be going through
  `pythonAdapter.parse`.
- **Recommendation:** No change today. After NN1 lands, run
  `grep -rn "import.*parsePython\b" packages/` and, if there are zero
  external consumers, consider dropping the named re-export. Out of
  scope for this audit.

## Findings missed in the prior audit

### M1 — `matchStringStart` no longer documents that the strip pass conflates raw and non-raw — but the test names still imply it does

- **F#:** M1
- **Severity:** Cosmetic / documentation clarity.
- **Where:** `packages/languages/lang-python/src/strip.ts` lines 59–65
  (function docblock explicitly says "we deliberately do NOT distinguish
  raw from non-raw here") vs the test grouping at
  `__tests__/adapter.test.ts` line 106 ("CPython semantics") and the
  comment at lines 107–112 framing this as a raw-string rule.
- **What:** Post-fix, the lexer treats raw and non-raw identically; that
  is the *correct* behavior because the strip pass is tokenization-bound,
  not value-extraction. But the test descriptions
  (`r"\"" — backslash-quote does not terminate the literal`) still read
  as if there is a special raw-string rule, which the docblock now
  explicitly disclaims. A future reader who finds the docblock first
  will be momentarily confused by the test names. (Verified during this
  audit pass — I read the docblock first and then the tests, and the
  framing mismatch was real.)
- **Why it matters:** Low. The tests still pass; the lexer is correct;
  this is a docs-vs-tests asymmetry only. But it is exactly the kind
  of thing the next person to touch the file will trip over.
- **Recommendation:** Either rename the test group to "tokenization
  semantics for backslash-quote (raw and non-raw alike)" or add a
  clarifying line at the top of the `describe` block that says "these
  are framed as raw-string tests because that is where the bug
  surfaced; the underlying rule applies to non-raw strings too." No
  source change needed.

### M2 — `aliases` array is in `LanguageAdapter` but not contract-validated

- **F#:** M2
- **Severity:** Cosmetic — applies to every lang pack, not Python-specific.
- **Where:** `packages/languages/lang-python/src/adapter.ts` line 10
  (`aliases: ['py']`); `packages/core/src/languages/adapter.ts` for the
  contract.
- **What:** Every adapter declares `aliases` but nothing in core
  enforces uniqueness across the registry. `lang-python` currently
  declares `['py']` and there is no collision today, but if a future
  pack also uses `'py'` (e.g. Pyret, PyPy targets) the registry will
  silently shadow.
- **Why it matters:** Non-finding for lang-python in isolation;
  surfacing because this audit is tasked with catching what was missed.
  The right fix is in core's `defaultLanguageRegistry`, not lang-python.
- **Recommendation:** Out of scope — flag for the core audit's next
  pass. No change in lang-python.

## Overall

lang-python is in a healthy state after Wave 1. F1 and F2 from the
prior audit are confirmed CLOSED with the right test shape. The pack's
strip lexer remains the most domain-specific of the family for
load-bearing reasons (Python quote rules are the outlier).

The single substantive delta is **NN1**: lang-python is now the only
pack that constructs its `MinimalTextTree`-shaped triple by hand
instead of delegating to `core.buildMinimalTextTree`. The other four
C-family packs migrated under commit `3d65016`. Migrating
lang-python is a 5-line change and removes the family-of-five-with-an-outlier
shape without losing any of F3's "future divergence is cheap" property
— the brand alias pattern handles that.

Layering remains clean: lang-python imports only from
`@opensip-tools/core` (lines 20 in strip.ts, 14 in parse.ts, 5 in
adapter.ts via `core/languages/adapter.js` subpath). No peer language
imports, no fitness, no contracts, no cli. SRP and DIP are
well-kept: `adapter.ts` does composition only, `parse.ts` returns the
text-tree triple, `strip.ts` owns the lexer state machine, `index.ts`
is a barrel.

Recommended follow-ups, in priority order:

1. **NN1** — migrate `parse.ts` to `buildMinimalTextTree`. Trivial
   patch; removes outlier status. (Supersedes prior F3.)
2. **F4** — add the two missing newline-recovery regression tests.
3. **NN2 / M1** — small docblock additions for future readers.
4. **F5 / F6** — unchanged from prior audit; out of scope here.
