---
status: current
last_verified: 2026-05-23
title: "Architecture audit (delta) — @opensip-tools/contracts"
package: "@opensip-tools/contracts"
audience: [contributors, architects]
prior-audit: ./2026-05-22-architecture-contracts.md
remediation-plan: ./2026-05-22-plan-layer-2-contracts.md
---

# Architecture audit (delta) — @opensip-tools/contracts

## Prior-finding status

Verified against the post-Wave-4 source tree at
`packages/contracts/src/` (7 files: `index.ts`, `types.ts`,
`exit-codes.ts`, `graph-catalog.ts`, `persistence/store.ts`, plus two
test files). The package is now ~700 LOC excluding tests, vs ~3,000
LOC before the dashboard extraction.

| # | Title (short) | Status | Evidence |
|---|---|---|---|
| F1 | `generateDashboardHtml` positional signature | **Closed (moved out)** | Symbol no longer in contracts; lives in `packages/dashboard/src/generator.ts` with the options-object shape. |
| F2 | Seven Code Paths views duplicated | **Closed (moved out)** | All `view-*.ts` modules are under `packages/dashboard/src/code-paths/`; not contracts' problem. |
| F3 | `getErrorSuggestion` six-arm if-chain | **Closed** | `exit-codes.ts:57-154` is now a flat `SUGGESTION_RULES` array; `getErrorSuggestion` (`:156-167`) walks it top-down. The bare `'config'` substring is gone, split into `opensip-tools.config.yml` (`:96`) and `YAML` (`:107`) rules. New table-driven tests in `__tests__/exit-codes.test.ts:38-99` cover each rule plus the four narrowed false-positives. |
| F4 | `StoredSession` / `FindingOutput` duplication | **Closed** | `store.ts:36-53` re-uses `CheckOutput` from `types.ts:122`; `FitDoneResult.findings` (`types.ts:210-212`) is `{ checks: readonly CheckOutput[] }`. The strict `severity: 'error' \| 'warning'` union holds at the active surface; legacy data flows through `LegacyStoredSession` (`store.ts:62-95`) and `migrateLegacyStoredSession` (`:119-150`). Round-trip test at `store.test.ts:317-335`. |
| F5 | Dashboard renderer in contracts | **Closed** | Entire `persistence/dashboard/` subtree moved to `@opensip-tools/dashboard`. Only one residual reference: a comment at `index.ts:10`. The dep-cruiser rule `contracts-imports-core-only` now lists `^@opensip-tools/dashboard` in the forbidden set (`.dependency-cruiser.cjs:117`). |
| F6 | `CliArgs` god-object | **Mitigated (deprecated, not removed)** | `types.ts:64-77` carries the `@deprecated` JSDoc tag. Adapter call-sites are flagged with `// eslint-disable sonarjs/deprecation` comments in `fitness/engine/src/tool.ts`, `simulation/engine/src/tool.ts`, `cli/src/commands/init.ts`. Per-PR plan, full rip-out deferred. |
| F7 | `panelOrchestratorJs` cross-tab handshake | **Closed (moved out)** | Lives entirely under `packages/dashboard/`; not contracts' surface. |
| F8 | Barrel re-exporting heavy module | **Closed** | `dist/index.d.ts` is 43 lines, runtime `dist/index.js` is 24 lines — no dashboard runtime in either. Verified with `cat`. |

No prior finding regressed. F1, F2, F5, F7 were resolved by extraction
rather than refactoring contracts itself; the package is now genuinely
contract-shaped.

## Net-new findings (introduced or surfaced by Wave 1–4)

### N1. `CliProgram` re-export forces transitive `commander` resolution on plugin authors

- **Severity:** P1
- **Where:** `packages/contracts/src/index.ts:95-114`; `packages/contracts/package.json:30-36` (commander is in `devDependencies`).
- **What:** The new `CliProgram` type alias is declared as
  `import type { Command } from 'commander'` and re-exported. The
  emitted `dist/index.d.ts:28` contains the same `import type` line.
  `commander` is only listed under contracts' `devDependencies`, so
  any consumer that depends on `@opensip-tools/contracts` and tries to
  use `CliProgram` (or even just resolves the full `.d.ts`) needs
  `commander` resolvable in their own `node_modules`. ISP / DIP — the
  type alias couples plugin authors to a concrete dispatcher library
  the contract is meant to abstract over.
- **Why it matters:** The doc-comment at `index.ts:108-113` claims the
  alias lets plugins type their `cli` parameter "without growing a
  direct `commander` dependency." That is the opposite of what the
  emitted shape does. Tool packages in this repo (`fitness`,
  `simulation`, `graph`) all happen to depend on `commander`
  themselves, so the issue does not show up on `pnpm typecheck`. A
  third-party plugin that *only* depends on contracts will see a
  `Cannot find module 'commander'` error from `tsc`. Plugin
  discoverability is one of the package's stated jobs (CLAUDE.md:
  "any npm package whose `package.json` declares
  `opensipTools.kind === 'tool'`").
- **Recommendation:** Two options, in order of preference:
  (a) Move `commander` into `peerDependencies` (with
  `peerDependenciesMeta.commander.optional = true`) so it surfaces in
  consumer dependency graphs without forcing an install. This makes
  the contract honest.
  (b) Replace `CliProgram = Command` with a structural sub-interface
  that captures only the surface plugins actually use
  (`.command(...)`, `.option(...)`, `.action(...)`, `.description(...)`)
  — a true ISP move. The type then has no `commander` import. This is
  a larger change but cleanly removes the coupling.
  Option (a) is the cheap honest fix; option (b) is the architecturally
  correct one. Either also fixes finding `N5` below.

### N2. `LegacyStoredSession` and `migrateLegacyStoredSession` are public-API surface for one internal caller

- **Severity:** P2
- **Where:** `packages/contracts/src/index.ts:73-78`; declared `store.ts:62-95, 119-150`.
- **What:** `LegacyStoredSession` (the type) and
  `migrateLegacyStoredSession` (the function) are both re-exported
  from the package barrel. The only runtime caller is `loadSessions`
  itself (`store.ts:292`). No package outside contracts imports
  either symbol — verified with `grep -rn` across `packages/`. SRP /
  ISP — the migration shape is an implementation detail of the
  persistence module, not a contract surface.
- **Why it matters:** Anything in `index.ts` is a stability promise.
  Today the migrate rule is "off-union severity collapses to warning,
  except critical/high → error" (`store.ts:103-108`); changing that
  later means a CHANGELOG breaking-change entry, even though no real
  consumer depends on it. Tests reach in via the relative path
  (`store.test.ts:17-22`), which works fine without the barrel
  export. The Phase 2 plan acknowledged this — the export was
  "needed by tests; otherwise keep internal" — but the test file
  imports from `'../persistence/store.js'` directly, so the barrel
  re-export buys nothing.
- **Recommendation:** Drop `LegacyStoredSession` and
  `migrateLegacyStoredSession` from `index.ts:73-78`. The
  `store.test.ts` imports already use the relative path. If a future
  external consumer needs the migrate function (extremely unlikely —
  it's tied to one specific JSON wire format), promoting it then is a
  one-line export. Today it's surface that future maintainers will
  feel obligated to preserve.

### N3. `graph-catalog.ts` is a typed shape duplicated structurally with no drift detector

- **Severity:** P2
- **Where:** `packages/contracts/src/graph-catalog.ts:12-90`; mirror in `packages/graph/engine/src/types.ts:58-145`.
- **What:** The contracts file declares `GraphCatalog`, `GraphFunctionOccurrence`, `GraphCallEdge`, `GraphParam`, `GraphFunctionKind`, `GraphCallResolution`, `GraphCallConfidence`, `GraphVisibility`. The graph engine declares its own `Catalog`, `FunctionOccurrence`, `CallEdge`, `Param` with overlapping but non-identical shapes — e.g. contracts has `GraphCatalog.version: string` (loose, deliberately, to allow parsing v2 files) while engine has `Catalog.version: '3.0'` (literal). The duplication is intentional per `graph-catalog.ts:5-9` (the §2.4 decoupling claim) and is the right call architecturally — contracts must not import from a Layer-3 tool. But there is no drift detector. SRP/DRY tension; no current pattern violation, but a known fault line.
- **Why it matters:** When graph adds a field (a `GraphCallKind` enum value, a new edge metadata field), contracts can drift silently. The graph engine's catalog writer emits the new field; contracts' `GraphCatalog` type doesn't see it; the dashboard reads the old shape and silently drops it. Today's tests don't catch this — the dashboard tests use contracts' shapes (`dashboard-view-untested.test.ts:17`) and graph's tests use graph's shapes; nothing asserts the two are subset-compatible.
- **Recommendation:** Add a single contract-test in `packages/graph/engine/src/__tests__/` (graph is the producer; the test belongs there, not in contracts) that imports both `Catalog` from local types and `GraphCatalog` from `@opensip-tools/contracts` and asserts at type-level that a real `Catalog` value is assignable to `GraphCatalog`. Three lines of code: `const _check: GraphCatalog = catalogFixture;`. This catches the next drift the moment it lands. Pure type-test — zero runtime cost, no architectural change.

### N4. `PluginResult` discriminator is `action`, not `type` — inconsistent with the rest of `CommandResult`

- **Severity:** P3
- **Where:** `packages/contracts/src/types.ts:337-347`; consumed by `cli/src/ui/components/PluginFeedback.tsx:22`.
- **What:** Every other `CommandResult` variant discriminates on `type` (e.g. `'fit-done'`, `'sim-done'`, `'list-checks'`). `PluginResult` is a union of four objects that all share `type: 'plugin'` and discriminate on a second field, `action: 'list' | 'add' | 'remove' | 'sync'`. `App.tsx` switches on `type` and lands all four variants in the `'plugin'` arm; `PluginFeedback` then switches on `action`. This is a working two-level dispatch but inconsistent with the rest of the file. GoF: discriminated union convention.
- **Why it matters:** Low-grade — it works. But: (1) future plugin actions add to two switches instead of one; (2) the symmetry of the `CommandResult` union breaks (every other variant is one `type` literal, this one is four behind a single `type`); (3) any tool that wants a similar fan-out (e.g. `sessions list/purge`) now has prior art for a second-level discriminator that may not be desirable.
- **Recommendation:** Two options:
  (a) Lift the variants up: rename `type` from `'plugin'` to `'plugin-list' | 'plugin-add' | 'plugin-remove' | 'plugin-sync'`, drop the inner `action`. `App.tsx` gains four cases; `PluginFeedback` simplifies. Most consistent.
  (b) Document the two-level convention in the JSDoc on `PluginResult` so future tools follow it intentionally rather than copy-paste-cargo it.
  Option (a) is the right shape; (b) is the cheap fix if the rename surface is large. Either is fine — flag in CHANGELOG as a minor consideration.

### N5. `commander` listed only as `devDependency` while emitted `.d.ts` references it

- **Severity:** P1 (sub-finding of N1)
- **Where:** `packages/contracts/package.json:30-36`; `dist/index.d.ts:28`.
- **What:** `dependencies` contains only `@opensip-tools/core`. `commander` is in `devDependencies`. But the published `dist/index.d.ts` imports `from 'commander'`. npm/pnpm consumers of the published tarball will not get `commander` resolved transitively.
- **Why it matters:** Same as N1 but called out separately because the fix is at the `package.json` level: even if `CliProgram` stays as-is, `commander` needs to move out of `devDependencies` (peer or runtime dep) to make the contracts tarball self-consistent.
- **Recommendation:** Bundled with N1 — move `commander` to `peerDependencies` with `optional: true`. If `CliProgram` is restructured per N1(b), `commander` can return to `devDependencies` because the type alias no longer references it.

## Findings the prior audit missed

The five above subsume the misses. Specifically:

- **N1/N5** are direct consequences of Wave 5's `CliProgram` re-export
  — the prior audit predates that change.
- **N2** was implicitly anticipated by the Phase 2 plan ("export
  `LegacyStoredSession` if needed by tests; otherwise keep internal")
  but the resulting code defaulted to exporting and no follow-up
  tightened it. The prior audit did not flag this independently.
- **N3** is the first audit pass over `graph-catalog.ts` as a contracts
  surface. The prior audit treated the type-only duplication as
  correct (it is) but did not call out the missing drift detector.
- **N4** is visible in the prior code (`PluginResult` predates Wave
  4) but was not flagged because the prior audit focused on the
  dashboard subtree. Wave 4's discriminated-union consolidation
  surfaced the inconsistency by drawing attention to the union shape.

## Overall assessment

The package is now genuinely contract-shaped. Removing the dashboard
subtree dropped the package from ~3,000 LOC to ~700 LOC and made every
remaining file fit the name on the tin: `types.ts` (CLI/result shapes),
`exit-codes.ts` (codes + suggestion table), `graph-catalog.ts` (typed
shape between graph and dashboard), `persistence/store.ts` (session
JSON I/O). No file does two jobs; the barrel exports a coherent surface.

`getErrorSuggestion` is now a textbook data-driven dispatch — readable,
extensible, ordered, and well-tested. The `Finding`/`CheckOutput`
consolidation is clean: one canonical declaration, one explicit
`LegacyStoredSession` for old wire data, one `migrate` step that
covers the realistic legacy severity values. `PluginResult` is a real
discriminated union now (caveat N4). The `CliArgs` deprecation flag is
in place at every adapter call site.

The remaining findings are small. **N1/N5** is the only one with
real teeth — a third-party plugin author hits a `commander` resolution
error today, and the doc-comment promises the opposite. **N2** is
hygiene; **N3** is a cheap drift-detector test; **N4** is a
consistency nit. None are blocking.

Layering is clean: dependency-cruiser passes, contracts depends only
on `@opensip-tools/core` at runtime (`dist/index.js` is 24 lines and
imports nothing structural), the new `^@opensip-tools/dashboard`
forbidden entry in `.dependency-cruiser.cjs:117` actively prevents the
back-edge regression. `App.tsx`'s `switch (result.type)` is still the
right shape for `CommandResult` dispatch — discriminated unions over
class hierarchies remains the correct call.

Recommended next sequencing: address N1/N5 (one PR, package.json +
short doc-comment fix or interface restructure), then N2 (one-line
barrel cleanup), then N3 (three-line type test in graph). N4 is a
backlog item — flag in CHANGELOG and revisit when the next plugin
action lands.
