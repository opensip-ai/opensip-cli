---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-python"
package: "@opensip-tools/checks-python"
audience: [contributors, architects]
supersedes: ./2026-05-22-architecture-checks-python.md
---
# Architecture audit (delta) — @opensip-tools/checks-python

Delta against the 2026-05-22 audit. Wave 4 closed both findings called
out previously, and the two unrelated lang-pack-cohort fixes from Wave 1
(`metadata.version` reads from `package.json`) and the barrel-shape
unification from `963852c` have left this pack in the cleanest shape it
has ever shipped. Three source files, three test files, one barrel, one
import graph edge into `@opensip-tools/fitness`, zero into anything else.

## Prior findings — verification

### F1 (prior) `metadata.version` literal drift — **CLOSED**

- **Severity:** was Low (cosmetic until load-bearing).
- **Where:** `packages/fitness/checks-python/src/index.ts:9`.
- **Verified:** `metadata.version` is now `readPackageVersion(import.meta.url)`
  (line 9), re-exported from `@opensip-tools/fitness`
  (`packages/fitness/engine/src/index.ts:16`, originating in
  `@opensip-tools/core` per `packages/fitness/engine/src/tool.ts:17`).
  Wave 1 commit `364c0be`. The pinning test
  (`__tests__/metadata.test.ts:17-20`) reads `package.json` at
  runtime and asserts equality, with a regression guard against the
  prior stale `'0.6.1'` literal (line 13). Single source of truth
  restored. Identical pattern in all three sibling small packs
  (`checks-go`, `checks-java`, `checks-cpp`). Closes Layer 4 Plan
  Phase B1.

### F2 (prior) Two near-duplicate test files — **CLOSED**

- **Severity:** was Low (review noise).
- **Where:** was `__tests__/analyze.test.ts` + `__tests__/no-bare-except.test.ts`.
- **Verified:** `analyze.test.ts` deleted (Wave 4 commit `1c4b027`).
  Surviving `no-bare-except.test.ts` (83 lines, 7 cases) absorbs the
  full matrix: bare `except:` on its own line (line 6), empty input
  (18), `except Exception:` (22), tuple types (31), `as` clause (40),
  indented bare except (49), multi-bare-except (60), and
  whitespace-before-colon (75). `run.test.ts` retained as designed —
  it covers the `defineCheck`-built `noBareExcept.run()` closure. No
  surface lost. Closes Layer 4 Plan Phase B2.

### F3 (prior) Pack-existence cost-benefit — **NO CHANGE (deferred)**

- **Severity:** was Informational.
- **Verified:** Pack still ships one check (`python-no-bare-except`).
  Recommendation stood at "no change"; revisit only if Python check
  growth stalls and pack still has ≤2 checks after another release.
  No additional Python checks have landed since 2026-05-22. Tracked
  in `2026-05-22-plan-layer-4-check-packs.md` Deferred section, line
  661. Status unchanged.

## Net-new findings (2026-05-23)

### NF1 — Barrel template uniform across all four small packs — **strength, no action**

- **Severity:** Informational.
- **Where:** `packages/fitness/checks-python/src/index.ts:1-11` vs
  `checks-go/src/index.ts`, `checks-java/src/index.ts`,
  `checks-cpp/src/index.ts`.
- **What:** Post-`963852c`, all four small-pack barrels are byte-equal
  modulo the per-pack identifiers (`noBareExcept`/`noFmtPrint`/
  `noPrintStackTrace`/`clangTidyPassthrough` and the package name +
  description string). Same shape: `readPackageVersion` import +
  single check import + `[check] as const` array + metadata literal.
  No named re-export, no parser-helper re-export (the cpp variant
  used to leak one).
- **Why it matters:** SRP at the package boundary — the barrel's
  single responsibility is to satisfy the `FitPluginExports`
  contract. The previous named re-export was a second public surface
  with no documented consumer (workspace search at the commit
  confirmed zero hits). Dropping it removes a two-place state
  obligation (rename a check, you had to update both the array and
  the re-export). This is a clean Adapter pattern: the barrel
  adapts the internal check module to the loader's expected shape,
  nothing more.
- **Recommendation:** None. Note for contributors: when adding a
  second Python check, follow the existing template — extend the
  array literal in place, do not introduce a named re-export.

### NF2 — `run.test.ts` JSDoc references the deleted file — **Low**

- **Severity:** Low (stale comment, not behavioural).
- **Where:** `packages/fitness/checks-python/src/__tests__/run.test.ts:6-7`.
- **What:** The fileoverview reads "The pure analyzer is exercised
  by analyze.test.ts and no-bare-except.test.ts." After Wave 4's
  `analyze.test.ts` deletion, the first reference is stale.
- **Why it matters:** Reviewer confusion — a contributor reading the
  rationale for `run.test.ts` will look for a file that no longer
  exists. Trivially correctable, but the merge that deleted
  `analyze.test.ts` should have caught this.
- **Recommendation:** Edit the JSDoc to read "The pure analyzer is
  exercised by `no-bare-except.test.ts`. This file's purpose is
  execution coverage for the un-called closures declared inside the
  check definition." One-line cleanup. Same likely applies to the
  sibling `checks-go/__tests__/run.test.ts` after its Wave 4
  consolidation; worth a sweep.

### NF3 — `metadata.test.ts` regression-guard literal anchors a specific past value — **Informational**

- **Severity:** Informational.
- **Where:** `__tests__/metadata.test.ts:13` —
  `expect(metadata.version).not.toBe('0.6.1');`.
- **What:** The pinning test asserts the version is *not* the
  specific prior stale literal `'0.6.1'`. This is belt-and-braces
  — the next assertion (`toBe(pkg.version)`) already fails if the
  hardcoded literal returned. The named guard adds zero new
  protection unless `package.json` itself ever happens to set
  `version` to `'0.6.1'`, in which case both assertions would
  conflict.
- **Why it matters:** OCP — the regression guard encodes an
  archaeological detail (the value drift had previously been at)
  rather than a forward-looking invariant. Not harmful, just
  taking up one assertion's worth of attention.
- **Recommendation:** Optional. Drop the `not.toBe('0.6.1')` line,
  or replace with a positive invariant ("never matches the
  hardcoded fallback used in the loader," etc.). Apply uniformly
  across all six pack `metadata.test.ts` files if cleaning up.

### NF4 — `analyze` line-number computation is O(n²) on pathological inputs — **Informational**

- **Severity:** Informational (carried forward from prior audit's
  "non-findings considered and dismissed", revisited because no
  other findings remain).
- **Where:** `packages/fitness/checks-python/src/checks/no-bare-except.ts:31-32`.
- **What:** `content.slice(0, match.index).split('\n').length`
  re-walks the prefix on every match. The Go and Java siblings
  iterate the file by line and accumulate the line counter,
  avoiding the reslice. For Python sources at realistic sizes the
  cost is invisible.
- **Why it matters:** Liskov-substitutability with the cohort —
  contributors looking at the four small-pack analyzers will find
  one shape in three packs and a different one here. Drift is the
  finding, not the cost.
- **Recommendation:** Defer. If a `defineRegexListCheck` /
  line-scanner helper lands in `@opensip-tools/fitness` per Layer 3
  Phase D6 / Layer 4 Phase C6, this analyzer collapses into a
  declaration and the question evaporates. Not worth a one-off
  rewrite.

## Missed in prior audit

None of substance. The prior audit named two findings; both are now
closed. The remaining two NF items above (stale JSDoc, regression-guard
literal) are artifacts of the closing CRs themselves — they did not
exist on 2026-05-22.

One observation that *could* have been called out 2026-05-22 but
wasn't: the `__tests__` directory has no `index.test.ts` smoke that
asserts `index.ts` exports `{ checks, metadata }` in the shape the
loader expects (`FitPluginExports`). The new `metadata.test.ts`
covers the `metadata` half; nothing covers `checks` being a non-empty
array of objects with `config.slug` strings. The prior audit's
`run.test.ts` rationale incidentally exercises one check's `run()`
but doesn't reach through the barrel. Severity Informational; consider
adding a one-`it`-block barrel-shape assertion to `metadata.test.ts`
when next touching it.

## Layering / DIP verification (re-confirmed)

- Source imports (`src/index.ts`, `src/checks/no-bare-except.ts`):
  `@opensip-tools/fitness` only. No `core`, no `contracts`, no
  `cli`, no sibling check packs, no `lang-*` (the Python adapter
  is reached via `applyContentFilter` inside fitness, registered
  by the CLI at boot).
- Test imports: `vitest`, `node:fs|os|path|url`, relative paths
  only. Zero reach into other workspace packages — even the
  metadata test reads `package.json` via `readFileSync` rather
  than importing the file. Compare to `checks-java`, where the
  test still imports `@opensip-tools/lang-java/strip` (Layer 4
  Plan Phase B3, still open).
- `package.json` declares one runtime dep
  (`@opensip-tools/fitness`) and dev deps only for
  `@types/node` and `vitest`. The dependency manifest matches
  the import graph exactly.

Architecture rules (`/Users/breens/Documents/Code/opensip-tools/.dependency-cruiser.cjs`)
pass without exemption.

## Overall

`checks-python` is the cleanest small lang-pack in the cohort as of
2026-05-23. Wave 1 fixed the metadata-drift, Wave 4 fixed the
test duplication, and the Wave 4 barrel uniformity commit
(`963852c`) leaves all four small packs sharing one template byte-
for-byte. SRP, DIP, and the loader contract are all satisfied with
the minimum sufficient code. The two NF items in this audit are
both Informational and neither blocks a release. No P0/P1 work
outstanding for this pack; F3's "should this pack exist?" question
remains correctly deferred until check growth provides evidence.
