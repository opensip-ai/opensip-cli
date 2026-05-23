---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-universal"
package: "@opensip-tools/checks-universal"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-checks-universal.md
related-plans: ./2026-05-22-plan-layer-4-check-packs.md
---
# Architecture audit (delta) — @opensip-tools/checks-universal

## Summary

Wave 4 closed the lion's share of the prior audit's structural debt:
the three TODO/FIXME detectors collapsed to one canonical pair
(`no-todo-comments` + extracted `no-ai-attribution` /
`no-process-artifacts`); the three test-modifier detectors collapsed
to two SRP-faithful checks; the two package-audit checks collapsed to
one (`dependency-vulnerability-audit`, now correctly filed under
`security/`); the `no-legacy-code` umbrella split into three named
checks with the weak heuristics dropped; and `directive-audit`
delegated four directive grammars to sibling parsers under
`_directives/`. The resilience barrel no longer re-exports
`config-validation-helpers`. All four previously-missing display
entries were added. Layering is still clean (no imports of `cli`,
`contracts`, `lang-*`, `simulation`, or sibling check packs). The
pack now ships 86 checks (down from 92, with two deletions and one
rename that consolidated three slugs into one).

What remains is small, three threads:

1. **`defineRegexListCheck` adoption stalled at 3 of ~13 sites**, and
   the deferred sites carry no in-file rationale for non-adoption.
   The audit prompt confirms the deferral is intentional, but a
   reader of any one deferred file (`no-hardcoded-secrets`,
   `heavy-import-detection`, `docker-best-practices`,
   `performance-anti-patterns`, `no-skipped-tests`,
   `no-focused-tests`, `no-ai-attribution`, `no-process-artifacts`)
   has no signal that the helper exists or why it was not used here.
2. **Helper modules still co-located with checks.** The barrel
   re-export was the load-bearing fix and is closed. The cosmetic
   half — moving `config-validation-helpers.ts` and
   `sentry-helpers.ts` into a `_helpers/` folder — was not done.
   Functionally fine; layout-wise still suggests "this directory
   contains checks" is approximate.
3. **One genuine new finding:** `no-todo-comments` (slug
   `no-todo-comments`) and `no-temporary-workarounds` (slug
   `no-temporary-workarounds`) both fire on the same `// HACK
   temporary fix` line. The umbrella overlap was resolved; a small,
   narrower overlap moved in with the `no-legacy-code` split.

The pack is in good shape. The plan-driven cleanup landed.

## Status of prior findings

| ID  | Title                                                                                  | Status | Notes |
|-----|----------------------------------------------------------------------------------------|--------|-------|
| F1  | Three TODO/FIXME detectors overlap                                                     | CLOSED | `quality/code-structure/todo-comments.ts` deleted; `comment-quality.ts` deleted; rules extracted into `no-ai-attribution.ts` and `no-process-artifacts.ts`. `no-todo-comments` is the canonical scanner. (See NF1 for residual narrow overlap with `no-temporary-workarounds`.) |
| F2  | Three test-modifier detectors overlap                                                  | CLOSED | `no-test-only-skip.ts` deleted; `concurrent.only/.skip` and `test.describe.only/.skip` patterns ported to `no-focused-tests.ts:21-31` and `no-skipped-tests.ts:14-25`. SRP-faithful split (`.only` = error, `.skip` = warning) preserved. |
| F3  | Fat "umbrella" checks bundle multiple sub-rules                                        | CLOSED (with caveat) | `no-legacy-code` split into `no-deprecated-tags.ts`, `no-compatibility-layer-names.ts`, `no-temporary-workarounds.ts`. Weak heuristics (version-check, shim-adapter, backwards-compat-comment) DROPPED. `comment-quality` deleted (handled by F1). `directive-audit.ts` is now 163 lines (down from 627), with parsers in `_directives/{typescript,eslint,fitness,semgrep,types}.ts`. The four-grammar single-check shape is intentional — accepted by the prior audit. |
| F4  | Missing shared "regex-list scanner" template                                           | PARTIALLY CLOSED | Helper `defineRegexListCheck` shipped in `@opensip-tools/fitness` (`packages/fitness/engine/src/framework/define-regex-list-check.ts`). Adopted at 3 sites: `no-console-log.ts:39`, `no-window-alert.ts:22`, `no-eval.ts:20`. The prior audit listed 13 candidates; 10 remain on the inline shape. See NF2. |
| F5  | Helper module re-exported through resilience barrel                                    | CLOSED | `resilience/index.ts` no longer carries `export * from './config-validation-helpers.js'`; consumers (`cache-ttl-validation.ts:10`, `dangerous-config-defaults.ts:11`, `no-hardcoded-timeouts.ts:14`, `retry-config-validation.ts:9`) import via relative path. `sentry/index.ts` likewise does not re-export `sentry-helpers`. See NF3 for the cosmetic remainder. |
| F6  | Misclassified categories — security checks under `quality/`                            | CLOSED | `dependency-security-audit.ts` deleted; `security-scan-suite.ts` renamed to `dependency-vulnerability-audit.ts` and moved to `security/`; barrel and display map updated (`security/index.ts:6`, `display/security-testing.ts:14`). |
| F7  | Display map missing entries for four real checks                                       | CLOSED | `file-length-limit` (`display/architecture.ts:14`), `heavy-import-detection` (`architecture.ts:15`), `stale-build-artifacts` (`architecture.ts:22`), `no-todo-comments` (`display/quality.ts:27`) all present. |
| F8a | Severity strings drift uppercase→lowercase (no-legacy-code, comment-quality)           | CLOSED | Both files deleted; new split files (`no-deprecated-tags.ts:73`, `no-compatibility-layer-names.ts:113`, `no-temporary-workarounds.ts:71`) declare `severity: 'error'` directly. `semgrep-scan.ts:24` still uses uppercase, justified — it mirrors the semgrep wire format. |
| F8b | `security-scan-suite` / `dependency-security-audit` / `semgrep-scan` overlap           | CLOSED | Same fix as F6. `security-scan-suite` slug renamed to `dependency-vulnerability-audit` (breaking; documented release note required). |

## Net-new findings

### NF1 — Residual TODO-marker overlap between `no-todo-comments` and `no-temporary-workarounds`

- **Files / code:**
  - `src/checks/no-todo-comments.ts:12` —
    `TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK|OPTIMIZE)\b/g` matches
    any of the five markers anywhere in a comment, with cross-language
    `scope.languages = []`.
  - `src/checks/quality/no-temporary-workarounds.ts:27-33` — fires on
    lines that contain `HACK` or `FIXME` *and* one of `temporary`,
    `workaround`, `before launch`. Scope `languages: ['typescript']`,
    `concerns: ['backend', 'frontend', 'cli']`.
- **Severity:** minor
- **What:** A line like `// HACK temporary; will fix before launch`
  fires both checks: `no-todo-comments` (warning, "HACK marker should
  be tracked in an issue") and `no-temporary-workarounds` (error,
  "implement permanent solution before launch"). Same line, same
  problem, two distinct slugs and severities — the same pattern that
  motivated the original F1 cleanup, just narrower.
- **Why:** The `no-legacy-code` umbrella split (closing F3) carried
  this rule across as a separate check rather than folding it under
  `no-todo-comments`. Both checks have a legitimate reason to flag
  HACK/FIXME — `no-todo-comments` flags the marker; `no-temporary-workarounds`
  flags the *qualifier* — but a user enabling both gets duplicate
  findings on every workaround line.
- **Recommendation:** Either (a) make `no-temporary-workarounds`
  emit a different `type` field and let the dashboard
  de-duplicate by line+file via the strictest finding (preferred —
  preserves the fact that a temporary HACK is *worse* than a
  generic HACK); or (b) have `no-todo-comments` skip its match
  when the same line carries one of the qualifier needles, deferring
  to the more specific check; or (c) document the precedence in
  both files' headers so a user reading them understands the
  intentional double-fire. The prior audit's TODO-cluster fix
  correctly resolved the umbrella problem; the residue is small
  and arguably-by-design, so this is a docs-or-dashboard change,
  not a structural one.

### NF2 — `defineRegexListCheck` non-adoption is undocumented at every deferred site

- **Files / code:** Adopted at 3 sites
  (`no-console-log.ts:39`, `no-window-alert.ts:22`, `no-eval.ts:20`),
  each with a fileheader comment ("Migrated to defineRegexListCheck
  (Layer 4 Phase C6) …" — see `no-window-alert.ts:9-13`,
  `no-eval.ts:6-10`, `no-console-log.ts:5-9`). Inline shape retained
  at:
  - `quality/patterns/performance-anti-patterns.ts:39-80` (5 patterns,
    nested-loop heuristic uses 2-line context window via `nextLine` —
    not modeled by the helper).
  - `architecture/heavy-import-detection.ts:20-43` (3 patterns plus
    a separate `EXCESSIVE_NAMED_IMPORT_THRESHOLD` rule that counts
    members inside the matched import — not a per-line scan).
  - `architecture/docker-best-practices.ts:39-80, 74-80` (multi-stage
    state machine; not a regex list).
  - `security/no-hardcoded-secrets.ts:25-103` (regex list — but
    every entry uses `/g` and emits per-match for *all* patterns;
    helper supports this, so this site looks like a candidate that
    deferred without documenting why).
  - `testing/no-focused-tests.ts:21-31`,
    `testing/no-skipped-tests.ts:14-25` (regex list with bespoke
    `generateReplacement` step — could become a helper option, or
    not).
  - `quality/code-structure/no-ai-attribution.ts:31-35`,
    `quality/code-structure/no-process-artifacts.ts:38-59` (regex
    lists, *new files* introduced by Wave 4's TODO-cluster split,
    written in the inline shape rather than the helper).
- **Severity:** improvement
- **What:** The prompt asserts the helper was "deferred per
  site-specific edge cases." For `docker-best-practices`,
  `performance-anti-patterns` (cross-line state),
  `heavy-import-detection` (the named-import-threshold rule), and
  `no-focused-tests`/`no-skipped-tests` (replacement-text generation),
  that is plausibly true — none is a pure per-line regex list. For
  `no-hardcoded-secrets`, `no-ai-attribution`, and
  `no-process-artifacts`, the shape is *exactly* the helper's target
  shape and there is no apparent edge case. None of the deferred
  files carries a comment naming the helper or explaining the
  decision; future contributors will not know the helper exists or
  why it wasn't used.
- **Why:** Without site-level documentation, the helper looks like
  dead code on a casual read of the package, the migration looks
  half-done, and the next regex-list check authored in this pack will
  reach for the inline pattern (the dominant style) rather than the
  helper.
- **Recommendation:** At each deferred site, add a one-line comment
  in the file header — either "Inline regex list retained: cross-line
  state needed for nested-loop detection" or "Migration to
  `defineRegexListCheck` deferred — see Phase C6". For the three sites
  where there is no apparent edge case (`no-hardcoded-secrets`,
  `no-ai-attribution`, `no-process-artifacts`), pick one: migrate, or
  state in-file why not. The new files (`no-ai-attribution`,
  `no-process-artifacts`) are the most surprising omissions because
  they were *authored in Wave 4* alongside the helper adoption.

### NF3 — Helper modules still co-located with checks

- **Files / code:**
  - `src/checks/resilience/config-validation-helpers.ts:1` — header
    pragma `@fitness-ignore-file fitness-check-architecture --
    Helper module providing shared validation utilities; not a
    standalone check requiring defineCheck pattern` confirms the file
    is consciously a helper.
  - `src/checks/resilience/sentry/sentry-helpers.ts` — same shape;
    no top-level `defineCheck` export.
- **Severity:** minor
- **What:** The barrel re-export was dropped (closing F5's
  load-bearing concern), so `collectCheckObjects` no longer surfaces
  these as candidates for registration. They still live inside
  `checks/<category>/`, where the directory contract is "files here
  are checks." A reader looking at the resilience folder sees 18
  `.ts` files and 17 of them are checks; a reader looking at
  `resilience/sentry/` sees 8 files and 7 are checks. The
  `@fitness-ignore-file fitness-check-architecture` pragma is the
  only signal.
- **Why:** It works, but the pack template implicitly says "checks
  may share a directory with helpers as long as the barrel doesn't
  re-export the helpers." That's a subtler contract than the original
  "files under `checks/<category>/` are checks." If the pack grows
  more shared helpers, the convention is fragile.
- **Recommendation:** Either move both helper files to
  `src/checks/_helpers/` (with a leading underscore to opt out of
  the directory contract — the pattern already used by
  `documentation/_directives/`), or promote them to
  `@opensip-tools/fitness/utils` if they're genuinely
  fitness-wide. The Wave 4 `_directives/` move is the precedent and
  this rounds out the pattern.

## Missed findings (re-reviewed prior audit, found no other gaps)

The prior audit's "Existing patterns (correct usage)" and "Non-findings"
sections were re-checked against current source. All still hold:

- Plugin contract honored (`src/index.ts:22-35`); `collectCheckObjects`
  walks the barrel; `metadata` now derived via `readPackageVersion`
  (`src/index.ts:33`) — closes the prior cohort-wide
  `metadata.version` drift via the Wave 1 `readPackageVersion`
  helper.
- DIP clean: a full `grep` of the `src/` tree for
  `@opensip-tools/{cli,contracts,lang-*,simulation}` returns zero
  hits outside `__tests__`.
- Pure-analyzer + `defineCheck` wrapper template still followed by
  `file-length-limit.ts:18`, `no-todo-comments.ts:20`,
  `no-hardcoded-secrets.ts:137`. The new split files
  (`no-deprecated-tags.ts`, `no-compatibility-layer-names.ts`,
  `no-temporary-workarounds.ts`, `no-ai-attribution.ts`,
  `no-process-artifacts.ts`) inline their analyzers. Not a finding —
  consistent with the rest of the pack — but a missed opportunity
  for the new files to set the template.
- `contentFilter` discipline preserved across the new files
  (`no-ai-attribution.ts:48` and `no-process-artifacts.ts:76` declare
  `'raw'` because they need to see comments; `no-todo-comments.ts:47`
  uses `'strip-strings'`).
- Sentry sub-pack (7 single-rule checks + helpers) untouched and
  remains the best-factored sub-domain.
- `no-raw-regex-on-code` meta-check still in place
  (`src/checks/quality/no-raw-regex-on-code.ts`) — this is what
  catches a regex check declaring the wrong `contentFilter`.
- The 16 nested barrel `index.ts` files are unchanged. Still
  defensible.

The display-map slug coverage is now complete for the checks the
prior audit flagged. Spot-checking the new check slugs against the
display maps:

- `no-ai-attribution` ✓ (`display/quality.ts:18`)
- `no-process-artifacts` ✓ (`display/quality.ts:24`)
- `no-deprecated-tags` ✓ (`display/quality.ts:21`)
- `no-compatibility-layer-names` ✓ (`display/quality.ts:19`)
- `no-temporary-workarounds` ✓ (`display/quality.ts:26`)
- `dependency-vulnerability-audit` ✓ (`display/security-testing.ts:14`)

No drift between the new slugs and the display map. Severity strings
are uniformly lowercase across the new files; the only uppercase
occurrence in the pack is `semgrep-scan.ts:24`, which is the
external-format translation already accepted as justified.

## Overall

Wave 4 is a substantive cleanup. Nine prior findings are closed (six
fully, two with cosmetic remainders, one with a small new finding
spawned by the legacy-code split). The pack went from 92 checks to
86, all by removing duplication and fat umbrellas, not by trimming
real coverage — the dropped `no-legacy-code` weak heuristics
(version-check, shim-adapter, backwards-compat-comment) were
acknowledged false-positive risk in the prior audit. The
`defineRegexListCheck` helper now exists and is the preferred shape
for new regex-list checks; adoption is partial (3 of ~13) and lacks
in-file rationale at the deferred sites, which is the largest open
item.

The pack is healthier and more navigable than it was a day ago. The
remaining work is documentation and one cosmetic move
(helpers → `_helpers/`) — both small, neither blocking the v1.0
release.
