# Architecture audit: @opensip-tools/dashboard (2026-05-23)

## Context

`@opensip-tools/dashboard` (v1.3.1, ~3,050 LOC across 29 source files)
was extracted from `@opensip-tools/contracts` in commit `399a19a`
(Layer 2 Phase 3); Phase 4 (commit `67e2343`) cleaned the public
surface to three constructs: the `DashboardInput` options object,
`defineRankedView` (used by four of seven Code Paths views), and the
`tabActivators` registry. Layer-3 peer of `fitness`/`simulation`/
`graph`/`lang-*`. `package.json` declares `core` + `contracts` as
deps; only `contracts` is actually imported (see F11). Fresh audit —
no prior `2026-05-22-architecture-dashboard.md`. The package's job is
one function: turn `DashboardInput` into a self-contained HTML string.
Most files emit JS source as TypeScript template strings that
`generator.ts` concatenates into one `<script>` block.

## Findings

### F1 — Generator hard-codes the four-tab layout
- Severity: P1
- Where: `generator.ts:120-157`, `tool-tabs.ts:79-99`
- What: OCP. `generateDashboardHtml` literally writes
  `<div data-tab="overview">…fitness…simulation…code-paths</div>` and
  then calls `renderOverview/Fitness/Simulation/CodePathsTab()` from a
  fixed list (lines 154-157). `tool-tabs.ts` similarly hard-codes
  `renderFitnessTab` / `renderSimulationTab`. Adding a new tool tab
  requires editing `generator.ts` *and* `tool-tabs.ts` *and* defining
  a new tool-tab function — exactly the central-dispatcher edit
  `tabActivators` and `defineRankedView` were introduced to avoid.
- Why it matters: Phase 4 modeled open-for-extension surfaces for
  cross-tab navigation (`tabActivators`) and ranked Code-Paths views
  (`defineRankedView`); the *primary* extension axis — adding a tool
  tab — is still closed. New tools cannot register a top-level tab
  without modifying dashboard internals, contradicting the CLI's
  "register a Tool, ship a package" narrative.
- Recommendation: introduce `defineToolTab({ id, label, icon, render
  })` mirroring `tabActivators` / `views`. `generator.ts` iterates
  the registry to emit tab buttons + panels and to call each tab's
  `render` JS string. Keep the Overview tab special (cross-tool
  aggregate by design).

### F2 — `renderToolTab` assumes the three-tab shape; Code Paths cannot use it
- Severity: P1
- Where: `code-paths.ts:96-116`, `tool-tabs.ts:21-73`
- What: SRP / OCP. `renderToolTab` bakes in the three-subtab
  "Overview / Catalog / Recipes" shape. Code Paths needs two subtabs,
  so `code-paths.ts` re-implements the entire subtab-bar/active-toggle
  pattern inline — duplicating click-delegation, active-class
  toggling, and panel mounting. The comment at line 95 acknowledges
  the mismatch.
- Why it matters: any new tool that doesn't fit the three-tab mould
  will copy-paste this 20-line block. The duplicated subtab logic
  already drifts — Code Paths' DOM ordering differs slightly from
  `tool-tabs`'.
- Recommendation: extract `renderSubtabBar(panel, subtabs[])` where
  each subtab is `{ id, label, render(panel) }` (Strategy).
  `renderToolTab` becomes a shim passing `[overview, catalog,
  recipes]`. Code Paths passes `[sessions, explore]`.

### F3 — `dashboardCodePathsJs` is a hand-ordered concatenation of 19 emitters
- Severity: P2
- Where: `code-paths.ts:39-61`
- What: SRP / DIP. The 19 JS-string emitters are concatenated in a
  topological order documented only by array adjacency. The contract
  is "if your view uses `passesFilter`, push it after
  `dashboardFiltersJs()`". No test guards this; reorder by mistake
  and the page silently fails with `passesFilter is not defined`.
- Why it matters: the only place the topological order lives is the
  array literal. New contributors cannot derive the order from the
  modules themselves.
- Recommendation: (a) attach `{ id, deps, emit }` descriptors and
  topologically sort at concat time; or (b) keep the manual order but
  add a comment listing each emitter's free identifiers and the prior
  emitter that declares them. At 19 emitters (b) is enough; revisit
  past ~30.

### F4 — `defineRankedView` punts type safety via spliced JS source strings
- Severity: P2
- Where: `view-template.ts:51-89, 119-163`
- What: ISP / type safety. The `RankedViewConfig` fields `metric`,
  `predicate`, `rowExtras`, `preamble`, `columns[].value` are all
  `string` — JS source spliced into the emitted view body. They close
  over in-page locals (`occ`, `indexes`, `filterState`,
  `passesFilter`, `displayName`, `packageOfPath`, `renderFunctionRows`)
  enforced only by convention (line 96). A typo in
  `metric: 'occ.callerz.length'` compiles, lints, and ships — fails
  silently in the browser.
- Why it matters: the abstraction is OCP-correct (new views are
  configs, not new files) but loses TS's type checking at the most
  load-bearing fields.
- Recommendation: short-term, add a `view-template` self-test that
  evals each emitted view body against a synthetic catalog with
  required locals stubbed. Medium-term, model `metric`/`predicate` as
  discriminated unions (`{ kind: 'callers' } | { kind: 'lines' } | {
  kind: 'expr', source: string }`) so common cases are typed and only
  truly bespoke metrics fall through to source-string.

### F5 — `metric === false` skip sentinel overloads a numeric field
- Severity: P2
- Where: `view-template.ts:141-145`; callers `view-hot.ts:28`,
  `view-wide.ts:33`
- What: SRP. `metric` is documented as numeric but silently overloaded
  with a `false` sentinel (`metric === false` → skip). `view-hot` and
  `view-wide` use it; `view-untested` does not. Every view-config
  author has to know the sentinel exists.
- Recommendation: split into `metric` (always numeric) and
  `skipWhen?: string` (predicate); update the two callers; remove the
  `=== false` branch.

### F6 — Coupling, SCCs, Search re-implement the standard shell boilerplate
- Severity: P2
- Where: `view-coupling.ts:13-141`, `view-sccs.ts:10-69`,
  `view-search.ts:12-95`
- What: OCP / DRY. Phase 4 noted these three "don't fit the
  rank-and-render shape," but the boilerplate *around* the unique
  parts is identical: empty-state guard, `makeSectionHeading`, card
  wrapper, table append, pagination. `view-sccs` lines 36-65 are 90%
  identical to `renderFunctionRows` in `function-row.ts`.
- Why it matters: every change to the `.section + .card +
  .data-table.sortable` pattern must be made in three bespoke views
  plus `function-row.ts`. The conformance test checks IDs but not
  rendering shape — drift is silent.
- Recommendation: extract `defineCustomView({ id, label, help,
  render(...) → { headingText, body: Node[] } })` that handles the
  shell. Drops ~80 lines and guarantees shape consistency.

### F7 — `renderToolTab` mixes injected catalog with global `recipeCatalog`
- Severity: P2
- Where: `tool-tabs.ts:71-72`
- What: DIP. `renderToolTab` injects `catalogData` and
  `renderCatalogFn`, but renders recipes via the implicit global
  `recipeCatalog`. Half-inverted, half-hard-wired.
- Why it matters: a per-tool recipe namespace (the natural next step
  once tools beyond fit/sim ship recipes) requires editing this
  central function. F1 in miniature.
- Recommendation: pass recipes as a parameter, or fold catalog +
  recipes into the `subtabs` argument from F2.

### F8 — Hard-coded `tool → tabName` and badge-style maps in Overview
- Severity: P2
- Where: `overview.ts:26-31, 42`
- What: OCP. `const tabMap = { fit, sim, graph }` and
  `toolBadgeStyles` (lines 26-30) are both hard-coded three-entry
  objects. Adding a tool means editing both literals.
- Why it matters: same gap as F1, lower-traffic. `tabActivators`
  handles the deep-link case; this handles the default case. Both
  should flow from one tool-tab descriptor.
- Recommendation: fold into F1's `defineToolTab` (carry `id`, `tool`,
  `accentVar`, badge color). Overview's two maps derive from the
  registry.

### F9 — `dashboardSharedJs` is a 237-line grab-bag of five concerns
- Severity: P2
- Where: `shared.ts:1-237`
- What: SRP. Bundles (1) tab-bar click handler; (2) `tabActivators`
  registry; (3) `el()` DOM helper; (4) pagination (page buttons,
  table, grouped); (5) sortable table activation + global
  `setTimeout(0)` init. Five reasons to change.
- Why it matters: each piece would be testable independently. The
  `setTimeout(0)` side-effect (line 233-235) wires sort handlers to
  tables that may not exist yet at the moment it fires.
- Recommendation: split into `shared/{dom,pagination,sortable,
  tab-activators,tab-bar}.ts`; `generator.ts` concatenates. Mirrors
  the `code-paths/` per-concern split.

### F10 — `panelOrchestratorJs` glues 9 concerns into 162 lines
- Severity: P2
- Where: `code-paths.ts:63-225`
- What: SRP. Does (1) catalog blob load (68-76); (2) subtab bar
  (97-116); (3) Sessions subtab wiring (118-123); (4) Explore chips +
  tab bar + view stack (137-181); (5) row-click delegation (163-167);
  (6) Escape handler (170-172); (7) hash deep-link (179-180); (8)
  `openCodePathsSession` cross-tab nav (199-219); (9) `tabActivators`
  registration (221-223).
- Why it matters: the Code Paths panel is the heaviest tab; this is
  where future bugs land. The `document.addEventListener('keydown',
  …)` at line 170-172 leaks if `renderCodePathsTab` runs twice.
- Recommendation: split into `code-paths/{panel,explore,cross-tab}.ts`.
  The `dashboardCodePathsJs` concat stays in `code-paths.ts`.

### F11 — `package.json` declares `@opensip-tools/core` but src never imports it
- Severity: P3
- Where: `package.json:29`; zero `from '@opensip-tools/core'` in src
- What: ISP. Dead dependency in the closure of every consumer.
- Why it matters: install-size + dependency-graph honesty. The
  layering rule permits core but doesn't require it.
- Recommendation: drop `@opensip-tools/core` from `dependencies`
  until something in src actually uses it. If the package's job is
  "render HTML from contract types," `core` has no business being a
  dep.

### F12 — `dashboardCss` is one 220-line `String.raw` literal
- Severity: P2
- Where: `css.ts:6-227`
- What: SRP. At least eight concerns in one literal: theme tokens,
  header, tabs, subtabs, cards/stats, data-table, pagination,
  badges, code-paths views, function-card overlay, help-drawer.
  Soft-marked by `/* ====== Code Paths panel ====== */` comments.
- Why it matters: edits land in wrong sections; per-view CSS cannot
  be imported alone for selector tests.
- Recommendation: split into `css/{theme,tabs,data-table,code-paths,
  function-card,help-drawer}.ts` and concatenate. Mirrors F9.

### F13 — `serializeOptionalBlob` switches on a 'json' | 'literal' kind
- Severity: P3
- Where: `generator.ts:64-82`
- What: SRP / OCP. Discriminant-string + switch is the textbook
  OCP-violator shape flagged elsewhere in this audit.
- Recommendation: if a third kind appears, split into
  `serializeAsJsonScript` and `serializeAsJsLiteral`. Otherwise leave.

### F14 — Empty-state literals duplicated across views
- Severity: P3
- Where: `view-hot.ts:36`, `view-big.ts:36`, `view-wide.ts:42`,
  `view-untested.ts:53`, `view-coupling.ts:54`, `view-sccs.ts:33`,
  `view-search.ts:71`, `code-paths.ts:122,129`
- What: DRY. `'No catalog loaded.'` appears verbatim in five views.
- Recommendation: optional `emptyState(message)` helper in
  `function-row.ts`.

### F15 — View conformance test stops at the View interface shape
- Severity: P3
- Where: `__tests__/dashboard-view-conformance.test.ts:46-67` (out of
  25 test files total)
- What: Tests / LSP. Conformance checks `id`, `label`, `typeof render
  === 'function'` only. Does not enforce that every view (a) renders
  the standard `.section + .card` shell, (b) has `help.title` and
  `help.sections.length > 0`, (c) produces a `data-body-hash` click
  target, (d) handles no-catalog identically. Drift is invisible.
- Why it matters: seven views are a Strategy family; this is the
  single LSP guard.
- Recommendation: extend conformance — each view given an empty
  catalog renders an `.empty` and doesn't throw; given a one-function
  catalog renders at least one element; has non-empty `help`. Would
  also catch the F6 shell drift.

### F16 — Public surface is closed: only `generateDashboardHtml` + `DashboardInput`
- Severity: P3
- Where: `index.ts:19-20`
- What: ISP. `defineRankedView`, `tabActivators`, `dashboard*Js()`
  emitters are package-internal — correct per Phase 4's "dashboard is
  one function" narrative. A third party cannot extend the dashboard
  without forking.
- Recommendation: keep as-is. When F1 lands `defineToolTab`, decide
  whether tool packages should be able to register Code Paths views
  too (export `defineRankedView`) or only top-level tabs.

### F17 — `tabActivators` is JS-runtime; the type system can't see it
- Severity: P3
- Where: `shared.ts:32-42`, `code-paths.ts:221-223`
- What: DIP. Plain JS object keyed by `StoredSession.tool`.
  Registration site uses `if (typeof registerTabActivator ===
  'function')` — defensive against accidentally-reordered concat. The
  guard is the F3 issue manifesting at the call site.
- Recommendation: drop the guard once F3's ordering is asserted.

## Overall assessment

A healthy v1.0 extraction. Layering is clean (only `contracts`
actually imported, zero couplings to fitness/simulation/graph/lang/
cli/checks, all CSS+JS inlined into one `<script>`). Phase 4's three
contributor abstractions (`DashboardInput`, `defineRankedView`,
`tabActivators`) are well-scoped. The material gaps cluster on the
*next* extension axis: adding a new tool tab still requires editing
`generator.ts` / `tool-tabs.ts` / `overview.ts` (F1, F2, F7, F8) —
exactly the kind of central-dispatcher edit Phase 4 paid down for
ranked views and cross-tab navigation. Remaining items are SRP/DRY
hygiene — `shared.ts` and `css.ts` as grab-bags (F9, F12), three
bespoke Code-Paths views with shared boilerplate (F6), and
`defineRankedView`'s JS-string fields punting type safety (F4, F5).
One package-hygiene oddity: `core` is a declared but unused dep
(F11). No P0s; F1/F2 are the right targets for the next
contributor-experience pass.
