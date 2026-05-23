---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-go"
package: "@opensip-tools/checks-go"
audience: [contributors, architects]
supersedes: ./2026-05-22-architecture-checks-go.md
---
# Architecture audit (delta) — @opensip-tools/checks-go

## Summary

Wave 4 closes the last open finding from the 2026-05-22 audit. The pack
is now in a clean steady state: a single `defineCheck`-shaped check
(`go-no-fmt-print`) with a pure analyzer, a barrel that matches the
unified small-pack template (checks array + `metadata` derived from
`package.json` via `readPackageVersion`), three test files that each
own a distinct surface (pure analyzer, framework wrapper, metadata
contract), and one runtime dependency on `@opensip-tools/fitness`. SRP
is honoured at file granularity, DIP holds (no inversions through
`cli`, `contracts`, `core`, `lang-go`, or sibling check packs), and
the public surface (`checks`, `metadata`) is exactly what the plugin
loader requires.

There are no NET-NEW findings. There is one MISSED observation
(test-coverage exclusion of `src/index.ts` in
`vitest.config.ts:7`), but it is informational rather than a defect.

## Prior findings — status

### F1 (prior) — `metadata.version` literal drifts from `package.json` — **CLOSED**

- **Status:** Closed by Wave 1 (commit `364c0be`) and verified at
  `packages/fitness/checks-go/src/index.ts:9`, which now reads
  `version: readPackageVersion(import.meta.url)`. The helper is
  re-exported from `@opensip-tools/fitness/index.ts:16` (originally
  defined in `@opensip-tools/core`), so the pack's lone runtime
  dependency stays intact.
- **Verification:** `metadata.test.ts:10–14` pins the version against
  the regex `^\d+\.\d+\.\d+`, explicitly forbids the historical
  `'0.6.1'` literal, and `metadata.test.ts:16–20` reads
  `package.json` and asserts equality with `metadata.version`. The
  contract is now executable, not just documented. `package.json:3`
  is `1.3.1`; the test would fail on any future drift.
- **Evidence of cohort sweep:** sibling barrels
  (`checks-python/src/index.ts`, `checks-java/src/index.ts`,
  `checks-cpp/src/index.ts`) use the same shape — the template
  converged in one CR.

### F2 (prior) — Two overlapping test files for the same pure function — **CLOSED**

- **Status:** Closed by Wave 4 (commit `1c4b027`).
  `src/__tests__/analyze.test.ts` was deleted; its unique cases
  ("multiple occurrences on a single line",
  "does not flag fmt.Sprint or fmt.Errorf",
  "method-style Print on other receivers", empty-content sanity
  check) were absorbed into `no-fmt-print.test.ts:54–70`. Directory
  listing confirms only three test files remain
  (`metadata.test.ts`, `no-fmt-print.test.ts`, `run.test.ts`), each
  with a distinct purpose.
- **Verification:** The surviving file is named after the source
  module — the convention the prior audit recommended. `run.test.ts`
  was correctly preserved (it covers the framework-wrapper closures
  inside `defineCheck`, a different surface from the pure analyzer).
- **Stale comment carryover:** `run.test.ts:5` still reads "The pure
  analyzer is exercised by analyze.test.ts and no-fmt-print.test.ts."
  The first half of that sentence is now false; this is the only
  visible artefact of the merge and is captured under MISSED below.

### F3 (prior) — Small `metadata` re-export adds noise without value — **CLOSED**

- **Status:** Closed by Wave 4 (commit `963852c`). The redundant
  `export { noFmtPrint } from './checks/no-fmt-print.js'` is gone;
  `src/index.ts` is now 11 lines: one helper import, one check
  import, the `checks` array, and the `metadata` object. The cohort
  template (go / python / java / cpp) is now uniform — confirmed by
  side-by-side read of the four barrels.
- **Verification:** A workspace search for
  `from '@opensip-tools/checks-go'` returns zero hits, so the drop
  is provably safe; the only consumer remains the plugin loader,
  which reads `pkg.checks` and `pkg.metadata` and never the named
  re-export. `noFmtPrint` is still reachable to plugin consumers via
  `pkg.checks[0]` per the loader contract.

## NET-NEW findings (Wave 4 → 2026-05-23)

None.

The Wave 4 changes (test merge, barrel template unification, version
drift fix) all reduce surface and align this pack with its three
siblings. They introduce no new SOLID/GoF violations:

- **SRP:** the barrel does plugin-contract export only; the check
  file owns one analyzer; each test file owns one surface (analyzer
  / wrapper / metadata).
- **OCP:** new Go checks slot in by adding a file under
  `src/checks/` and including it in the `checks` array — the existing
  one-line, append-only export shape is the canonical extension
  point.
- **LSP / ISP:** `defineCheck` returns a `Check` value object; there
  is no inheritance to break.
- **DIP:** the only runtime import is `@opensip-tools/fitness`
  (`no-fmt-print.ts:13`, `index.ts:1`); no transitive reach into
  `core`, `cli`, `contracts`, `lang-go`, or sibling packs. The
  `'go'` content-filter dispatch is purely declarative
  (`no-fmt-print.ts:51`) and resolves through the registered
  language adapter at runtime — exactly the indirection DIP
  prescribes.
- **Barrel uniformity:** the four small-pack barrels are now byte-for-byte
  isomorphic apart from the check name and description, which is the
  intended template shape.
- **GoF patterns:** Strategy (`contentFilter` selects an adapter
  behaviour without the check knowing the implementation) and
  Template Method (the framework's analyzer-wrapping logic in
  `defineCheck`) are used correctly; the pure-analyzer +
  thin-execute-closure shape (`no-fmt-print.ts:23–53`) is the
  intended split.

## MISSED — items the prior audit did not flag

### M1 — Stale doc comment in `run.test.ts` after the test merge

- **F#:** M1
- **Severity:** Trivial (comment-only).
- **Where:** `packages/fitness/checks-go/src/__tests__/run.test.ts:5`.
- **What:** The file header reads
  > "The pure analyzer is exercised by analyze.test.ts and
  > no-fmt-print.test.ts."

  After Wave 4's merge (commit `1c4b027`), `analyze.test.ts` no
  longer exists; the analyzer has a single home in
  `no-fmt-print.test.ts`. The same stale phrasing exists in
  `checks-python/src/__tests__/run.test.ts` — it is a cohort-wide
  copy-paste artefact, not a checks-go-specific defect.
- **Why it matters:** Low. It misleads a future reader into looking
  for a deleted file. No functional impact.
- **Recommendation:** Update the comment to "The pure analyzer is
  exercised by `no-fmt-print.test.ts`." Apply the same edit to the
  python pack in the same one-line CR.

### M2 — `vitest.config.ts` excludes `src/index.ts` from coverage

- **F#:** M2
- **Severity:** Informational.
- **Where:** `packages/fitness/checks-go/vitest.config.ts:7`.
- **What:** `coverage.exclude` lists `src/index.ts`. The barrel is
  in fact unit-tested — `metadata.test.ts:7` imports `metadata`
  from `'../index.js'` and asserts on it — so the exclusion
  understates real coverage rather than masks an untested module.
  The same exclusion is present across the small-pack cohort and
  was not called out in any prior audit.
- **Why it matters:** Low. Coverage reports under-represent the
  barrel; a future contributor adding a non-trivial export to
  `src/index.ts` would not see an immediate red signal in the
  coverage delta.
- **Recommendation:** Drop the `'src/index.ts'` entry from
  `coverage.exclude`. Worth applying uniformly across the four
  small-pack `vitest.config.ts` files in one CR. Optional — the
  current state is not a defect, just a precision miss.

### M3 — Mixed semicolon style across test files (pre-existing, unflagged)

- **F#:** M3
- **Severity:** Trivial (style).
- **Where:** `src/__tests__/run.test.ts` and `metadata.test.ts` use
  trailing semicolons; `src/__tests__/no-fmt-print.test.ts` and
  `src/checks/no-fmt-print.ts` and `src/index.ts` do not.
- **What:** No project-wide ESLint rule enforces either; both
  shapes parse and pass `pnpm lint`. The drift is visual only.
- **Why it matters:** Negligible. Worth resolving when next this
  area is touched, not on its own.
- **Recommendation:** Pick one. The cohort majority across the four
  small packs trends no-semicolon; `run.test.ts` and
  `metadata.test.ts` are the outliers and both look templated from
  an older snippet.

## Overall

Two waves landed exactly the recommended fixes from the 2026-05-22
audit and one additional one (B4 barrel-template unification) with
no scope creep:

| Prior F# | Wave  | Commit    | Status |
|----------|-------|-----------|--------|
| F1       | 1     | `364c0be` | CLOSED |
| F2       | 4     | `1c4b027` | CLOSED |
| F3       | 4     | `963852c` | CLOSED |

`@opensip-tools/checks-go` now satisfies every load-bearing layering,
contract, and SRP rule the workspace enforces (dependency-cruiser
holds; the plugin-loader contract is honoured; the barrel,
content-filter dispatch, and `defineCheck` usage match the
documented patterns). Net surface has shrunk: 11-line barrel,
53-line check, three test files. There are zero NET-NEW SOLID/GoF
findings.

Three MISSED items are surfaced for completeness (M1 stale comment;
M2 coverage exclusion of a tested barrel; M3 semicolon drift). All
three are trivial and cohort-wide rather than checks-go-specific.
None block release; if addressed, they should be addressed across
all four small packs in one CR per concern, matching the discipline
Wave 4 already established.

The pack is, for the first time since the audit started tracking it,
**finding-clean**. Future audits should re-evaluate only on
material change — the addition of a second Go check, a Go content
filter rework, or a switch in the small-pack template.
