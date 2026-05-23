---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/checks-java"
package: "@opensip-tools/checks-java"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-checks-java.md
---
# Architecture audit (delta) — @opensip-tools/checks-java

## Summary

Wave 4 (commits `884ab1d`, `963852c`) completed the cohort-realignment
work the prior audit teed up. `@opensip-tools/lang-java` is gone from
`package.json` entirely, the duplicate `analyze.test.ts` is gone, the
unit test no longer imports any `lang-*` package, and the barrel matches
the Go/Python/C++ shape exactly. The Wave 1 `metadata.version` drift fix
(`364c0be`) is in place and pinned by a dedicated `metadata.test.ts`.
Production source is two files (`src/index.ts`, `src/checks/no-printstacktrace.ts`),
both depending on `@opensip-tools/fitness` only, and the test surface is
the canonical small-pack trio (`metadata.test.ts`, `<check>.test.ts`,
`run.test.ts`) — same as `checks-go`, `checks-python`, `checks-cpp`.
Layering, SRP, DIP and barrel uniformity are all clean. **No active findings.**

## Status of prior findings

### Prior F1 — `lang-java` runtime dependency consumed only by tests via subpath — **CLOSED**

`package.json:27-29` now lists only `@opensip-tools/fitness` under
`dependencies`. There is no `lang-java` entry in either `dependencies` or
`devDependencies`. `grep -rn "lang-java" packages/fitness/checks-java/`
returns nothing. The production-DIP claim from the prior summary
(content filter dispatched through `defaultLanguageRegistry`) is now
also the test-time DIP — `run.test.ts` calls `noPrintStackTrace.run(cwd, …)`
and lets `applyContentFilter` (`packages/core/src/languages/content-filter-dispatch.ts:37-53`)
look up the adapter; when no adapter is registered it falls back to raw
content (line 42-49), which is fine because the fixture (run.test.ts:32-44)
contains no comment/string false-positives. The check pack is now
strictly `fitness`-dependent. Closes prior F1.

### Prior F2 — test-side reach into `lang-java/strip` diverged from cohort — **CLOSED**

`no-printstacktrace.test.ts:1-3` now imports only `vitest` and the
analyzer under test. The file's docstring (lines 4-12) explicitly
documents the cohort convention: pure-analyzer tests use comment-free
and string-free fixtures, and end-to-end content-filter coverage lives
elsewhere (`run.test.ts`, plus framework-level tests in `core` and
`fitness`). Fixtures (lines 14-59) are bare Java statements with no
string literals or comments — exactly the Go-pack approach the prior
audit recommended (option (a)). Closes prior F2.

### Prior F3 — hard-coded `metadata.version` stale at `0.6.1` — **CLOSED**

`src/index.ts:1,9` reads version from `package.json` via
`readPackageVersion(import.meta.url)` — the Wave 1 cohort fix from
commit `364c0be`. `metadata.test.ts:10-20` pins three properties: the
shape is semver, it is *not* the previous stale literal `'0.6.1'`, and
it equals the value parsed from `package.json` at runtime. The same
shape now applies across `checks-go/src/index.ts:1,9`,
`checks-python/src/index.ts:1,9`, `checks-cpp/src/index.ts:1,9`. The
cohort-coordination concern the prior audit raised has been addressed —
the fix landed everywhere at once. Closes prior F3.

## NET-NEW

None. The pack is the smallest publishable shape: one production check,
one barrel, three tests, two prod dependencies in the import graph
(`@opensip-tools/fitness` and, transitively, `@opensip-tools/core`).
Every claim in the prior audit's "Existing patterns (correct usage)"
section still holds and there are no new violations introduced.

Two observations worth recording but not raising as findings:

- **Test fixture/import-style drift inside `__tests__/`.** The three
  test files do not agree on quotes or semicolons:
  `metadata.test.ts:1-7` uses single quotes + semicolons,
  `no-printstacktrace.test.ts:1-3` uses single quotes and no
  semicolons, `run.test.ts:18-24` uses single quotes + semicolons.
  Style only — Prettier/ESLint config in the workspace allows both,
  there is no behavioural impact, and the same drift exists in sibling
  packs. Not a finding.
- **`run.test.ts` does not exercise `applyContentFilter` end-to-end
  with a Java adapter loaded.** Confirmed by reading lines 11-17 of
  the file, which acknowledge it explicitly: registering the adapter
  in the test would duplicate CLI boot logic. The framework-level
  filter contract is covered in `@opensip-tools/core` and
  `@opensip-tools/fitness`; this pack treats it as out of scope. The
  prior audit's recommendation (option (b) — "extend run.test.ts with
  comment/string false-positive fixtures") was rejected with a
  documented rationale. That is a defensible call: the test boundary
  for an adapter-driven filter belongs at the adapter layer, not on
  every consumer. Not a finding; recorded so a future contributor
  doesn't re-litigate it.

## MISSED

None. I re-read every file under `packages/fitness/checks-java/src/`
and `package.json` against SRP, DIP, OCP, ISP, LSP, the GoF Template
Method/Strategy interpretations relevant to `defineCheck`, and the
barrel-uniformity / test-surface / dependency-manifest conventions.
The pack is at the floor of what an architectural audit can flag:

- **SRP.** `analyzePrintStackTrace` (`src/checks/no-printstacktrace.ts:24-42`)
  is a pure function over `string`; the `defineCheck` wrapper at
  lines 44-55 layers configuration on top. The two responsibilities
  are clearly separated and individually testable.
- **DIP.** Production code depends only on `@opensip-tools/fitness`
  abstractions (`defineCheck`, `CheckViolation`, `readPackageVersion`).
  No reach into `cli`, `contracts`, `simulation`, `core/*` subpaths,
  or any sibling `lang-*` or `checks-*` pack. The
  `lang-no-fitness-except-typescript` and `check-pack-no-cli` rules in
  `.dependency-cruiser.cjs` are honoured.
- **Barrel uniformity.** `src/index.ts` is 11 lines, identical in
  shape to `checks-go/src/index.ts`, `checks-python/src/index.ts`,
  `checks-cpp/src/index.ts` — same import order, same export order,
  same `metadata` shape, no named re-export of the check. The
  template has truly converged.
- **Test surface.** Three files, three responsibilities:
  `metadata.test.ts` pins the plugin contract values,
  `no-printstacktrace.test.ts` covers the pure analyzer,
  `run.test.ts` exercises the framework-wrapped closure. No overlap,
  no duplication, no `lang-*` reach. Identical structure to the Go
  and Python packs.
- **Plugin contract.** `checks` exports a `readonly` tuple containing
  the single `defineCheck` result (`src/index.ts:5`); `metadata`
  carries `name`, `version`, `description` (`src/index.ts:7-11`),
  satisfying `FitPluginExports`.
- **The "drop lang-java" choice itself.** This is the architecturally
  load-bearing decision in Wave 4 and it is the right call. The
  alternative — a `devDependencies` entry plus a registration shim in
  test setup — would have re-introduced the very coupling the prior
  audit flagged, just with a `dev-` prefix. Treating the
  content-filter contract as a framework concern (covered by `core`
  and `fitness` tests) and letting the per-pack tests fall back to
  raw content matches how every other small pack handles the
  filter. Pack publishes thinner, no install footprint added for a
  test-only concern, no subpath import to be broken by a future
  rename in `lang-java/package.json`. The trade-off — `run.test.ts`
  cannot demonstrate the filter actually strips a Java string
  literal — is acknowledged in the file's docstring and is the right
  side of that line.

## Overall

The pack moved from "good shape with three minor findings" to "no
findings, fully aligned with cohort." Every prior finding is closed
with a clean, verifiable code-level change, no regressions were
introduced, the design choice underpinning the change (route the
content-filter contract through framework-owned tests, not per-pack
ones) is sound and consistent with how the cohort already operated.
Adding a second Java check is now a single-file additive edit
(`src/checks/<slug>.ts` + barrel re-export + tests) — the template is
done.

If/when Java check growth justifies it, two future evolutions are
worth flagging (still not findings today):

1. If a future Java check needs comment-aware detection that the
   current regex pattern can't express, the pack will need either
   (a) a TS-AST-style approach with java-parser, or (b) the framework
   to gain a richer per-language helper than `applyContentFilter`.
   Either is out of scope for an audit on a one-check pack.
2. If a `defineRegexListCheck` helper lands in fitness (Layer 4
   Phase C6), `no-printstacktrace` is a candidate to migrate alongside
   the cross-language sites — it would reduce to a ~10-line declaration
   plus a single regex.

Neither blocks anything today. The pack is closed.
