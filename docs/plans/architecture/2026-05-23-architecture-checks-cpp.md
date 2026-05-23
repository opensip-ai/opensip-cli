---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-cpp"
package: "@opensip-tools/checks-cpp"
audience: [contributors, architects]
supersedes: ./2026-05-22-architecture-checks-cpp.md
---
# Architecture audit (delta) — @opensip-tools/checks-cpp

Wave 4 delta audit. The 2026-05-22 audit raised four findings (F1–F4)
and the Layer 4 plan tracked them under Group A/B. This pass verifies
those, scans for net-new findings introduced by the Wave 1/4 edits
(`efba14c` parser hardening, `364c0be` `metadata.version` drift fix,
`963852c` barrel-template uniformity), and re-walks the pack against
SRP, DIP, barrel uniformity, parser correctness, and test surface.

## Prior-finding status

| ID | Title (short) | Plan phase | Status |
| -- | -- | -- | -- |
| F1 | Parser captures file path but discards it | A1 | **CLOSED** — verified |
| F2 | Brittle regex parsing of clang-tidy stdout | Deferred | **OPEN (deferred)** |
| F3 | `note:` lines silently dropped despite JSDoc claim | Deferred | **OPEN (deferred)** |
| F4 | `args` flag-array allocated per call (`QUIET_ARGS`) | Deferred | **OPEN (deferred)** |

Cohort drift surfaced in plan Phase B1 (`metadata.version`) and
Phase B4 (barrel template) is **CLOSED** for this pack.

### F1 verification (CLOSED)

`packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:52`
now reads `match[1]` into `filePath` and `match[3]` into `colStr`.
`resolveFilePath` (lines 22–31) calls `path.resolve(cwd, capturedPath)`
then `path.relative(cwd, absolute)` and returns the project-relative
form when the file is inside `cwd`, leaving paths outside `cwd`
absolute (mirrors the `parseSemgrepOutput` shape called for in the
prior audit). The emitted violation now sets both `filePath` and
`column` (lines 63–64). Regression coverage in
`src/__tests__/clang-tidy.test.ts:15-29` (inside-cwd → relative;
outside-cwd → absolute), `:31-36` (column capture), and `:78-96`
(per-file grouping yields two distinct buckets, not the empty-string
collapse the bug produced). F1 is fully discharged.

### Phase B1 verification (CLOSED)

`src/index.ts:1,9` now imports `readPackageVersion` from
`@opensip-tools/fitness` (re-exported from core at
`packages/fitness/engine/src/index.ts:16`) and computes
`metadata.version` from the pack's own `package.json` via
`import.meta.url`. The `metadata.test.ts:9-25` triple-asserts the
shape (semver, no stale `0.6.1`, equal to `package.json`). DIP holds:
the pack still depends only on `@opensip-tools/fitness`.

### Phase B4 verification (CLOSED)

`src/index.ts` is now identical in shape to its three sibling small
packs (`checks-go`, `checks-python`, `checks-java`): a `checks`
tuple, a `metadata` literal, and **no named re-exports**. The
previously redundant `export { parseClangTidyOutput } from …` and
`export { clangTidyPassthrough } from …` lines are gone (commit
`963852c`). Tests that need the parser import it directly from the
source module
(`src/__tests__/parse.test.ts:3`,
`src/__tests__/clang-tidy.test.ts:3`,
`src/__tests__/run.test.ts:11`), so the deletion does not break any
real consumer.

## NET-NEW findings

### N1. Two test files now assert overlapping parser behaviour

- **F#:** N1
- **Severity:** Low
- **Where:**
  `packages/fitness/checks-cpp/src/__tests__/parse.test.ts:1-71`,
  `packages/fitness/checks-cpp/src/__tests__/clang-tidy.test.ts:1-97`.
- **What:** Both files target `parseClangTidyOutput` and both walk
  the same scenarios: warning-with-lint, error severity, missing
  lint name, `note:` line skipped, multi-diagnostic parsing, empty
  stdout. `clang-tidy.test.ts` is the strictly-stronger superset —
  it adds `filePath` (relative + absolute), `column`, and per-file
  grouping that the F1 fix relies on. `parse.test.ts` predates F1
  and never re-asserted `filePath`/`column`. Note also that
  `parse.test.ts:8` passes `cwd = ''` — after the F1 change that
  produces a valid run only by accident (`path.resolve('', 'a/b')`
  resolves against `process.cwd()`), so the older file's contract is
  weaker than the new one.
- **Why:** Same SRP/duplication concern flagged for the cohort in
  Layer 4 plan Phase B2 (currently scoped to checks-python and
  checks-go's `analyze.test.ts` siblings) — two files testing one
  pure function drift and double-maintain. The Wave 1 F1 fix
  exposed the drift here: only one of the two files actually exercises
  the new contract.
- **Recommendation:** Extend Phase B2 to absorb checks-cpp. Keep
  `clang-tidy.test.ts` (named after the source module, matches the
  cohort convention post-B2), delete `parse.test.ts`, port any
  uniquely-asserted case (the only candidate is `parse.test.ts:49-58`
  "skips lines that do not match the expected format" — easy to
  copy) into the surviving file. Update Phase B2's `Files:` block to
  add `Delete: packages/fitness/checks-cpp/src/__tests__/parse.test.ts`.

### N2. `parse.test.ts` semicolon-style drifts from the rest of the pack

- **F#:** N2
- **Severity:** Trivial
- **Where:**
  `packages/fitness/checks-cpp/src/__tests__/parse.test.ts` (uses
  trailing semicolons),
  vs `clang-tidy.test.ts`, `run.test.ts`, `metadata.test.ts`, and
  the pack source under `src/checks/` (no trailing semicolons in
  the post-Wave-1 files).
- **What:** Cosmetic style drift between the older test file and
  every other file in the pack. ESLint allows both — it's not a lint
  error — but the inconsistency is one more reason the file is
  the "old" half of N1's duplication.
- **Why:** Strengthens the case for resolving N1 by deletion rather
  than reformatting both files.
- **Recommendation:** Subsumed by N1. No separate action.

### N3. `cwd = ''` accepted silently by the parser

- **F#:** N3
- **Severity:** Low
- **Where:**
  `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:22-31`
  (`resolveFilePath`); exercised at `parse.test.ts:8,30,33,38-39,44-45`
  with empty `cwd`.
- **What:** When `cwd === ''`, `path.resolve('', captured)` resolves
  against the *process* `process.cwd()` rather than failing fast.
  That means a misconfigured caller can silently produce file paths
  rooted at the test runner's cwd (typically the package root), and
  the F1 contract — "`filePath` is project-relative when inside
  `cwd`, absolute otherwise" — is undefined for empty input.
- **Why:** Defensive-programming-by-construction. The `command`-mode
  parser signature (`(stdout, stderr, exitCode, files, cwd)`) is
  always called by `executeCommandMode`
  (`packages/fitness/engine/src/framework/define-check.ts:158-189`)
  with a non-empty cwd in production, so this is a test-side
  weakness rather than a runtime bug. But it's the same shape as the
  pre-Wave-1 silent-`filePath`-loss bug: a parameter is accepted in
  states that don't make sense and the failure mode is subtle output
  drift, not a thrown error.
- **Recommendation:** When N1 is resolved, ensure the surviving
  test file passes a real cwd in every case (`'/x'`, `'/proj'`,
  etc., as `clang-tidy.test.ts` already does). Optionally add an
  early `if (!cwd) cwd = process.cwd()` or — better — a precondition
  assertion. No source change needed if test cleanup is sufficient;
  the production caller never violates the contract.

### N4. JSDoc still claims notes are "attached to the prior diagnostic when possible"

- **F#:** N4
- **Severity:** Low (documentation honesty)
- **Where:**
  `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:33-39`.
- **What:** Prior audit raised this as F3 with three options
  (update JSDoc, append to `suggestion`, adopt `--export-fixes`).
  Plan deferred F3 to bundle with the YAML migration (F2). Wave 1
  plan text said "the JSDoc should be edited as part of Phase A1 to
  say 'notes are dropped' so the documented contract matches the
  implementation." Phase A1 shipped (F1) but the JSDoc was not
  edited — line 38 still reads "note lines are attached to the prior
  diagnostic when possible (kept simple for MVP — current
  implementation skips them)." which has the same self-contradicting
  shape as before.
- **Why:** Docstring-as-contract drift. The `(kept simple for MVP …
  current implementation skips them)` parenthetical was meant to
  rescue the contradiction; an honest reader still has to reconcile
  "attached when possible" against "skips them". The fix is one
  line.
- **Recommendation:** Trivial doc edit, scoped under existing F3
  deferral or carried as a sub-bullet of Phase A1's follow-ups.
  Suggested wording: "`note:` lines are dropped today; revisit when
  adopting `clang-tidy --export-fixes`, where notes are first-class
  children of diagnostics." This was the prior audit's
  Recommendation 1 ("Quick fix") and is the cheapest possible close.

## MISSED items from prior audit (re-walk)

A re-walk of SRP, DIP, barrel uniformity, parser correctness, and
test surface against the prior audit's "Existing patterns" and
"Non-findings" sections finds no missed structural issues. Specific
checks performed:

- **SRP (one check per file).** Pack has one source file with one
  check (`clang-tidy-passthrough.ts`) plus one helper
  (`resolveFilePath`). The helper is correctly file-private (not
  exported). No splitting needed.
- **DIP (depends on fitness/core/lang-cpp).** `package.json`
  declares only `@opensip-tools/fitness` as a runtime dep. The
  source imports `defineCheck` and `CheckViolation` from the
  fitness barrel, plus `node:path`. No cross-pack imports, no core
  subpath imports, no `lang-cpp` reach (which would be an inversion
  — `lang-cpp` is a peer of `fitness` and shouldn't be a runtime
  dep of a check pack the way a TS-AST check pack might pull
  `lang-typescript` for parser access). The pack-author surface is
  exactly one barrel.
- **Barrel uniformity.** `src/index.ts` matches checks-go,
  checks-python, checks-java line-for-line in shape: import
  `readPackageVersion`, import the check, export `checks` tuple,
  export `metadata` literal. Verified by reading all four barrels
  side-by-side.
- **Parser correctness post-F1.** The Windows-path concern (F2)
  remains the only known parser-correctness gap and is correctly
  deferred. The regex on
  `clang-tidy-passthrough.ts:14` would still mis-tokenize
  `C:\proj\foo.cpp:42:10:` (drive letter `C` consumed as the path
  capture, `\proj\foo.cpp` consumed as the line capture, then
  `Number.parseInt('\proj\foo.cpp', 10)` returns `NaN`, and the
  emitted violation has `line: NaN, filePath: <resolved 'C'>`). No
  change of severity since 2026-05-22.
- **Test surface.** Four test files: `parse.test.ts` (legacy, see
  N1), `clang-tidy.test.ts` (post-F1 superset), `run.test.ts`
  (end-to-end execution coverage of the closure inside
  `defineCheck` — unchanged from prior audit and correctly
  CI-tolerant of `CheckAbortedError`), `metadata.test.ts` (added
  Wave 1 to pin version against `package.json`). The `metadata`
  test correctly guards the prior `0.6.1` literal regression.
- **Non-findings dismissed in 2026-05-22 are still dismissed.**
  `display/` directory, embedded `--checks=`, `_stderr`/`_exitCode`
  underscore-prefix, fixtures-directory, `'c'` alias — all unchanged
  in scope and still correctly out-of-scope.

## Overall

The pack is healthier now than at 2026-05-22. F1 (the only P0 in
Layer 4) is closed with verifiable test coverage. The cohort drift
phases (B1 `metadata.version`, B4 barrel template) closed cleanly
and the pack is shape-identical to its three siblings. DIP is
unviolated; SRP holds at one-check-per-file with a private helper;
the parser regex is the same shape it was, with the file-path bug
removed.

The remaining Wave 4 items are small. N1 (parse-vs-clang-tidy test
file duplication) extends Phase B2's existing remediation scope by
one file. N4 (the unedited JSDoc-vs-implementation contradiction
flagged in F3 last cycle) is a one-line doc edit that can ride
alongside the next change to this file. N3 is defensive-cleanup
that's worth picking up only when N1 is resolved. F2 (Windows paths
/ `--export-fixes` migration) and F4 (`QUIET_ARGS`) remain correctly
deferred; nothing observed this cycle moves them up the queue.

No changes recommended to the Layer 4 plan beyond adding
`Delete: packages/fitness/checks-cpp/src/__tests__/parse.test.ts`
(and a port of its single unique case) to Phase B2's file list.
