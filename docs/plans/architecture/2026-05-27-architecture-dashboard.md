# Architecture audit — dashboard

**Date:** 2026-05-27
**Scope:** packages/dashboard
**Auditor:** Claude

## Summary

`@opensip-tools/dashboard` is a single-purpose HTML emitter: it takes a
`DashboardInput` (sessions + optional catalogs + editor protocol) and
returns one self-contained HTML string. It depends only on
`@opensip-tools/contracts`, has no consumer-leaking imports of fitness/
simulation/graph engines, and the boundary between dashboard and
fitness's `dashboard` CLI command is clean — fitness assembles the
`DashboardInput` payload and the package treats every field as opaque
JSON. The header is mildly fitness-flavoured (the `<title>` says
"Pass Rate") and the Recent Activity columns assume fit/sim-shaped
`summary.passed/failed/errors/warnings`, but those are local renderer
details, not API leaks.

The architecturally interesting choices live inside the package. The
package is built around three patterns: (a) a **Registry** of
`ToolTabDescriptor`s that drives the top-level tabs and Overview's
badge/tabMap derivation; (b) a string-emitter **Composite** where each
sub-module returns a JS-string fragment and `generator.ts` concatenates
them; and (c) a `defineRankedView` **Template Method** that turns four
of the seven Code Paths views into a small declarative config. The
Registry and Template Method are appropriate and well-applied. The
string-emitter composition is the dominant source of risk: the
emitted JS is one shared global scope with manually-tracked
declaration order, no type-checked contract between producers and
consumers, and `defineRankedView` accepts JS source as string fields
that are spliced verbatim with explicitly documented "no
type-checking" comments.

Five findings are actionable refactors; the rest are smaller
observations and a couple of correctness sharp edges (escape-handler
leak, two unrelated overlays sharing a singleton DOM key).

## Findings

### F1 — String-emitter composition: load-bearing concatenation order, single global scope

- **Files:** `packages/dashboard/src/generator.ts:176-189`,
  `packages/dashboard/src/code-paths.ts:78-100`,
  `packages/dashboard/src/shared.ts:32-40`
- **Principle/Pattern:** Module boundaries / Information hiding / Composite
- **Status:** Problematic
- **Evidence:**
  - `code-paths.ts:43-77` documents the topological order in prose:
    "Concatenation order is load-bearing — each emitter declares
    top-level names that later emitters reference. […] reordering
    will silently break the page with `<name> is not defined`."
  - `shared.ts:18-23` mirrors the same warning: "Any change to the
    order should be considered carefully — the pagination helpers
    reference `el`, the sortable helper references the pagination
    helpers […]"
  - Every emitter file (e.g. `code-paths/view-hot.ts`,
    `code-paths/filters.ts`) declares top-level `function` and `const`
    names that close over free identifiers like `el`, `passesFilter`,
    `displayName`, `graphCatalog`, `graphIndexes`, `views`,
    `filterState`, `notifyViews`. Two state singletons mutate in place
    (`graphCatalog` at `code-paths.ts:131`, `filterState` at
    `code-paths/filters.ts:21`).
- **Why it matters:** The package has rebuilt JavaScript's module
  system out of string concatenation. Every emitter is implicitly
  coupled to the set of free identifiers the page exposes; that set
  is enforced by code review and a comment, not by the compiler.
  Two of those identifiers (`graphCatalog`, `filterState`) are
  mutable module-scope state shared across files. Adding a new view
  or a new shared helper is a five-file edit (write the emitter,
  register it in `code-paths.ts`, pick a slot in the topological
  order, update the dependency comment, hope you got it right) and
  the failure mode is a runtime `ReferenceError` in a generated HTML
  file the dev may not even open during build.
- **Recommendation:** Move from "JS as string" to "JS as authored
  module" plus a single bundle step. Two viable paths:
  1. Author every emitter as a real ESM module under `src/runtime/`
     with normal `import`/`export`, then bundle with esbuild/rollup
     into one IIFE string at package build time and `String.raw`
     it back into `generator.ts`. The order problem disappears,
     `el`/`passesFilter`/etc. become real imports, dead code gets
     stripped, and `vitest` can unit-test the runtime modules
     against `jsdom` directly instead of asserting on generated
     strings.
  2. If 1 is too heavy, at minimum group the free identifiers into
     a single runtime object passed through `renderXxxTab(ctx)`
     (Context pattern) so each emitter's implicit deps are stated
     in its function signature and the topo sort comment goes away.

### F2 — `defineRankedView` accepts raw JS source as string fields

- **Files:** `packages/dashboard/src/code-paths/view-template.ts:64-127,157-201`,
  callers `view-hot.ts:28-33`, `view-big.ts`, `view-wide.ts`,
  `view-untested.ts`
- **Principle/Pattern:** Template Method / Open-Closed / Type safety
- **Status:** Problematic (correct pattern, dangerous parameterisation)
- **Evidence:** `view-template.ts:51` — "JS source for the cell value,
  spliced VERBATIM into the emitted view body — there is no TS
  type-checking on this expression"; same warning on `metric`
  (line 76-91), `predicate` (97-105), `rowExtras` (107-113),
  `preamble` (115-120). The comment at line 46-48 spells out the
  failure mode: "A typo here (`o => o.callerz`) compiles, lints, and
  ships — it will fail at runtime as an undefined property read, not
  a build error."
- **Why it matters:** The Template Method is the right pattern for
  four views that differ only by metric + columns, and the dedup
  payoff is real. The parameterisation, however, defeats the whole
  point of choosing TypeScript: each config field is a string of
  JavaScript that can reference free identifiers that may or may not
  exist in the page's scope, with no compile-time check at all. This
  is the same risk as F1, concentrated into one helper.
- **Recommendation:** Push the rank-and-render skeleton into the
  emitted runtime instead of into the build step. The runtime would
  expose `defineRankedView({ id, label, metric: (occ, indexes) =>
  number, predicate: (occ, fs) => boolean, columns: [{ label,
  value: occ => string }], … })` as a real function that views call
  with real closures. The build-time `view-*.ts` then becomes a
  thin emitter that JSON-stringifies the config _structure_
  (id, label, help, columns.label, headingText, emptyMessage) and
  emits the callback functions as actual function literals — no
  string splicing. Coupled with F1's bundling, every callback
  becomes type-checked source.

### F3 — Tool-tab Registry is the right pattern, but registration is a side-effect import

- **Files:** `packages/dashboard/src/tool-tab-registry.ts`,
  `packages/dashboard/src/tool-tabs-registrations.ts`,
  `packages/dashboard/src/generator.ts:18`,
  `packages/dashboard/src/overview.ts:13`
- **Principle/Pattern:** Registry / Open-Closed
- **Status:** Correct usage, fragile wiring
- **Evidence:**
  - `generator.ts:18` — `import './tool-tabs-registrations.js' //
    side-effect: registers fit/sim/graph`
  - `overview.ts:13` — same side-effect import duplicated, with the
    same trailing comment.
  - The header doc in `tool-tab-registry.ts:17-19` says the Overview
    tab is "intentionally NOT in this registry — it is a cross-tool
    aggregate by design".
- **Why it matters:** Two modules need the registry populated before
  they iterate it, so both do a side-effect import. If a third
  consumer is added and forgets the side-effect import, the new
  consumer silently sees an empty registry — the symptom is "Recent
  Activity rows have no badge style and don't navigate", which is
  visually nothing on an empty dashboard. Side-effect imports are a
  recurring footgun in ESM.
- **Recommendation:** Make registration explicit. Either:
  (a) export a `getDefaultToolTabs()` function from
  `tool-tabs-registrations.ts` that returns the array (no mutable
  registry), or (b) keep the registry but call
  `registerDefaultToolTabs()` once at the top of
  `generateDashboardHtml` and have `listToolTabs` throw if it's
  invoked before registration. Both move the wiring from
  "module-load order" to "explicit call".

### F4 — Overlay singleton is shared across two unrelated consumers

- **Files:** `packages/dashboard/src/code-paths/function-card.ts:22-30`,
  `packages/dashboard/src/code-paths/view-coupling.ts:98-138`
- **Principle/Pattern:** Singleton
- **Status:** Problematic (two responsibilities sharing one resource)
- **Evidence:** Both `openFunctionCard` (function-card.ts:23) and
  `openCouplingDrilldown` (view-coupling.ts:102) look up
  `.function-card-overlay`, reuse it if present, and write different
  content into it. The Coupling drill-down comment explicitly says
  "We piggyback on the overlay used by the universal Function Card
  to keep the singleton invariant" (view-coupling.ts:100-101).
- **Why it matters:** Singleton-by-DOM-class-name is a hidden global.
  The Coupling card and the Function Card are semantically
  different surfaces (one shows a function's callers/callees, the
  other shows call sites between two packages) that happen to use
  the same DOM container. A change to `closeFunctionCard` semantics
  (e.g. focus restoration, history hook) silently changes the
  Coupling drill-down's close behaviour. Tests for one will pass
  while a regression in the other ships.
- **Recommendation:** Extract a small `Overlay` helper —
  `openOverlay(builder)` and `closeOverlay()` that own the
  singleton DOM element, escape handling, and backdrop click
  delegation — and have both Function Card and Coupling drill-down
  call it with their own content builders. The "card" content
  becomes a Strategy passed into the overlay.

### F5 — Escape handlers attach to `document` from inside per-render emitters

- **Files:** `packages/dashboard/src/code-paths.ts:236-238`,
  `packages/dashboard/src/code-paths/help-drawer.ts:43-45`
- **Principle/Pattern:** Resource ownership / RAII
- **Status:** Problematic (latent leak)
- **Evidence:**
  - `code-paths.ts:236` adds a `document.addEventListener('keydown', …)`
    every time `renderCodePathsExplore` runs; the surrounding
    docstring (line 124-125) admits "if `renderCodePathsTab` runs
    more than once (it does not today) the handler would leak".
  - `help-drawer.ts:43` adds a second document-level keydown listener
    at emitter-load time.
- **Why it matters:** Multiple top-level `keydown` listeners exist
  for the same Escape semantics across two files; the comment says
  "it does not today" which is exactly the kind of invariant that
  rots when someone adds a Sessions ⇄ Explore toggle that re-mounts
  the Explore subtab. The right design is one keydown delegator on
  document that asks each currently-open dismissable surface to
  close itself.
- **Recommendation:** Introduce a tiny `dismissables` registry in
  `shared/`: `registerDismissable(predicate, close)` returns an
  unregister handle; a single document-level Escape listener walks
  the registry. Function Card, Help Drawer, and any future modal
  use that one API. The Explore re-render comment can then go away
  because the registration is render-scoped via the unregister
  handle.

### F6 — `dashboardOverviewJs` emits fit/sim-shaped table columns assuming `summary.passed/failed/errors/warnings`

- **Files:** `packages/dashboard/src/overview.ts:35-78`,
  `packages/dashboard/src/sessions.ts:35-61`
- **Principle/Pattern:** Liskov Substitution / Interface segregation
- **Status:** Problematic (latent leak through to "tool" abstraction)
- **Evidence:** `overview.ts:35` hard-codes the column set
  `['Timestamp','Tool','Recipe','Pass Rate','Status','Checks',
  'Findings','Duration']` and reads `s.score`, `s.summary.passed`,
  `s.summary.total`, `s.summary.errors`, `s.summary.warnings`,
  `s.durationMs`. `sessions.ts:36` does the same. The header
  comment in `tool-tab-registry.ts:27-30` claims tools that don't
  carry per-session state can still register a tab. They can — but
  if their `StoredSession` shape doesn't match this column set
  every row degrades to "0/0" + "0".
- **Why it matters:** The package claims to be tool-agnostic but
  the Overview row and the per-tool session table are
  fit/sim-shaped. Adding a new tool whose session is shaped
  differently (e.g. an `audit` tool with a different summary) will
  ship with mis-rendered rows and no compile-time signal — the
  `StoredSession` type in contracts is the same for every tool.
- **Recommendation:** Either narrow the public claim — say
  Overview's Recent Activity table is for fit/sim-shaped sessions
  and a tool with a different summary shape contributes its own
  Overview row via the registry — or extend `ToolTabDescriptor`
  with a `renderOverviewRow(session) => HTMLTableRowElement`
  strategy so each tool owns its own columns. The second is
  more consistent with the rest of the registry design.

### F7 — `subSimulationTab` ships dead code (`catalogData = []`, `renderCatalogFn = () => {}`)

- **Files:** `packages/dashboard/src/tool-tabs.ts:66-76`
- **Principle/Pattern:** YAGNI / explicit absence
- **Status:** Problematic (small, but symptom of missing abstraction)
- **Evidence:**
  ```ts
  renderToolTab(
    'panel-simulation', simSessions, 'var(--accent-sim)', 'Scenarios',
    [],                          // No scenarios yet
    function(container, data) {},  // empty renderer
    recipeCatalog
  );
  ```
- **Why it matters:** The Simulation tab is "the fit shape minus
  catalog content", expressed by passing `[]` and a no-op renderer.
  The shape mismatch is being silently absorbed. If a future tool
  has only Overview (no catalog, no recipes), this scales to
  passing more `[]` and more no-ops. The right way to absorb
  optional subtabs is to make `subtabs` declarative on the tab
  descriptor.
- **Recommendation:** Lift the subtab list onto `ToolTabDescriptor`
  itself: `subtabs: Array<{ id, label, render(panel, sessions) }>`.
  Fitness registers `[overview, catalog, recipes]`; Simulation
  registers `[overview, recipes]` (or `[overview]` until scenarios
  ship); Code Paths registers `[sessions, explore]` and stops
  having its own bespoke orchestrator. The Strategy pattern that's
  already half-implemented in `subtab-bar.ts` becomes the single
  way to express a tab's content.

### F8 — Tab DOM activation duplicated across emitters

- **Files:** `packages/dashboard/src/shared/tab-bar.ts:9-18`,
  `packages/dashboard/src/code-paths.ts:271-291`,
  `packages/dashboard/src/overview.ts:52-66`
- **Principle/Pattern:** DRY / Strategy
- **Status:** Problematic
- **Evidence:** Three call sites all do
  `document.querySelectorAll('.tab').forEach(t =>
  t.classList.remove('active'))` + same for `.tab-panel` + activate
  one. `openCodePathsSession` further drills into subtabs by the
  same pattern (code-paths.ts:280-287).
- **Why it matters:** Tab activation is the same operation
  expressed three different ways. Any change to how a tab becomes
  active (e.g. focus management, ARIA, route hash update) has to
  be made three places. The `tabActivators` registry already
  exists for cross-tab navigation; it should be the only place
  that knows how to make a tab active.
- **Recommendation:** Add an `activateTab(id)` and
  `activateSubtab(panel, id)` helper to `shared/tab-bar.ts` (or a
  new `shared/tab-controller.ts`), have the click handler call it,
  and have `openCodePathsSession` and the Overview row-click
  fallback call the same helpers. The `tabActivators` registry
  then composes on top: "for this session.tool, switch to tab X
  and tell its activator to do tool-specific drill-in".

### F9 — `defineCheck`-style descriptor on `ToolTabDescriptor` is the right shape; consumer needs equivalent for graph views

- **Files:** `packages/dashboard/src/code-paths/views-registry.ts:13-30`,
  `packages/dashboard/src/code-paths/view-*.ts`
- **Principle/Pattern:** Registry (consistency)
- **Status:** Missing opportunity
- **Evidence:** Tool tabs use `defineToolTab(descriptor)` returning
  `ToolTabDescriptor`. Code Paths views, conversely, push raw
  literals into a global `views = []` array from inside emitted JS
  strings (e.g. `view-sccs.ts:12 — views.push({ id: 'sccs',
  label: …, render(…) { … } })`). There is no TS-side `defineView`
  helper that gives the literal a type.
- **Why it matters:** The two registries are isomorphic in intent
  (a registry of descriptors driving a tab-bar) but inconsistent
  in implementation. Tool tabs are typed at TS build time; Code
  Paths views are typed only by convention. The asymmetry makes
  it harder to reason about how to add a new view vs how to add a
  new tab; new contributors will reasonably assume both work the
  same way.
- **Recommendation:** Either (a) bring views up to parity with
  tabs — declare a TS-side `View` interface, expose
  `defineGraphView(descriptor)` in contracts, and have the
  emitters JSON-serialize the descriptor plus emit the `render`
  callback (see F2 for the type-safe path), or (b) explicitly
  document that views are runtime-only because they need closure
  over runtime state, and accept the asymmetry as a deliberate
  scope line.

### F10 — `serializeOptionalBlob` is a small Strategy hidden as a switch

- **Files:** `packages/dashboard/src/generator.ts:76-97`
- **Principle/Pattern:** Strategy / Open-Closed
- **Status:** Correct usage at current scale; noted as future watchpoint
- **Evidence:** The function takes `kind: 'json' | 'literal'` and
  branches in a `switch`. The two arms duplicate the
  `escapeForScriptContext` + `JSON.stringify` logic with different
  envelopes.
- **Why it matters:** Today there are two arms and one call each;
  the `switch` is fine. If a third inlining format lands (e.g.
  base64-decoded blob for very large payloads, gzip-then-base64
  for graph catalogs at scale), the switch will grow. The
  Open-Closed answer is a small map: `{ json: (id, v) => …,
  literal: (id, v) => …, … }`.
- **Recommendation:** Leave as-is. Revisit when a third
  serializer lands; the refactor is a 10-line change at that
  point.

### F11 — `paginateGroupedRows` reaches into the table via DOM string conventions

- **Files:** `packages/dashboard/src/shared/pagination.ts:67-110`,
  callers `checks.ts`, `sessions.ts`
- **Principle/Pattern:** Information hiding / coupling
- **Status:** Problematic (small)
- **Evidence:** `paginateGroupedRows` identifies a group by
  scanning siblings for `classList.contains('expander-row')`. The
  `expander-row` class is a string contract spread across
  `checks.ts:180`, `sessions.ts:155`, and `pagination.ts:72`.
- **Why it matters:** A class-name typo at the call site silently
  un-groups rows (the expander row paginates separately, which
  visually misaligns it from its parent). The grouping invariant
  belongs to a data structure, not a CSS class.
- **Recommendation:** Have the caller pass a grouped structure
  (`groups: HTMLTableRowElement[][]`) directly into
  `paginateGroupedRows`. The CSS class can remain for styling,
  but `pagination.ts` stops parsing it.

### F12 — `dashboardCss` and `dashboardSharedJs` are ordered Composites with prose contracts

- **Files:** `packages/dashboard/src/css.ts:22-30`,
  `packages/dashboard/src/shared.ts:32-40`
- **Principle/Pattern:** Composite
- **Status:** Correct (low risk at current scale)
- **Evidence:** Both files just concatenate sub-emitters in a
  specific order. The CSS file says "the order below matches the
  original source order so the emitted stylesheet remains
  byte-stable for snapshot tests" (css.ts:6-11). The shared file
  has a one-paragraph topo doc (shared.ts:11-23).
- **Why it matters:** At seven CSS modules and five shared-JS
  modules this is manageable. The CSS one is the safer of the two
  (CSS is cascade-tolerant; the worst order failure is a wrong
  specificity, not a `ReferenceError`).
- **Recommendation:** No change today. If F1 lands, both of these
  collapse into the bundler's natural module-graph order and the
  prose contracts go away with it.

## Strengths

- **Tight package boundary.** `index.ts` exports exactly two
  symbols (`generateDashboardHtml`, `DashboardInput`). The
  dependency on `@opensip-tools/contracts` is the only workspace
  edge. Fitness's `dashboard` command (`fitness/engine/src/cli/
  dashboard.ts:158-164`) is a thin assembler — there is no
  knowledge of `generateDashboardHtml`'s internals on the consumer
  side, and the package doesn't reach back into fitness for
  anything.
- **Registry pattern applied correctly for top-level tabs.**
  `tool-tab-registry.ts` is the right abstraction; `overview.ts`
  derives its badge map and tab map from the registry instead of
  hard-coding fit/sim/graph (overview.ts:17-22). Adding a tab is
  one `defineToolTab` call.
- **Template Method pulled four ranked views into declarative
  config.** `view-template.ts` is a real reduction: `view-hot.ts`
  is ~25 lines of config rather than ~70 lines of duplicated
  rank-and-render. The pattern is right; only the
  parameterisation (F2) is the problem.
- **Subtab Strategy is consistent across two consumers.**
  `renderSubtabBar(panel, [...])` (`subtab-bar.ts:39-74`) is used
  by both `renderToolTab` (3 subtabs) and `renderCodePathsTab`
  (2 subtabs). One DOM/click-delegation implementation; two
  shape-different consumers — Strategy applied correctly.
- **Script-context escape is centralized and uniform.**
  `escapeForScriptContext` (generator.ts:50-52) and
  `serializeOptionalBlob` (generator.ts:76-97) mean every
  user-data interpolation into the inline `<script>` block goes
  through one helper. The `editorProtocolJs` arm comment
  (generator.ts:88-90) shows the maintainer thought about the
  `</script>` close-tag attack on the `'literal'` arm too.
- **Sound algorithms in the emitted runtime.** The iterative
  Tarjan SCC implementation (`scc.ts`) explicitly comments why it
  is iterative ("so deep call graphs don't blow the JS engine
  stack"); the index builder (`indexes.ts`) is the right two-pass
  shape; the call-graph drill-down caps at 200 hits
  (`view-coupling.ts:131-133`) to bound the DOM cost.

## Notes

- The single hard fit/sim coupling at the HTML level is the
  `<title>` tag: `OpenSIP Tools — Pass Rate: ${latestScoreSafe}%`
  (generator.ts:142). For a sim-or-graph-only project the title
  reads "Pass Rate: 0%" which is misleading. Minor — but a
  registry-driven `titleFormatter(latestSession)` strategy would
  fit the package's existing style.
- `editor-link.ts:14` hard-codes the recognized editor protocols
  (`vscode`, `cursor`). If a third editor lands this is a
  one-line edit, but it is also the kind of list that wants to
  live in `contracts/` or be passed in alongside `editorProtocol`
  as the actual URL template.
- The eight CSS modules and five shared JS modules in
  `src/css/` and `src/shared/` have a "concerns separated" feel
  that pays off in file size (the largest is `data-table.css.ts`
  at 89 lines). No findings here — just noting that the split is
  well-judged.
- `tests/__tests__/` is rich (≈25 test files), most asserting on
  the generated HTML or running it through `jsdom`. That is the
  right testing strategy for the current architecture; if F1
  lands the tests move from "string contains" to "real ESM
  import" and get much faster + sharper.
- `package.json` declares only `@opensip-tools/contracts` as a
  runtime dep and `jsdom` only as devDep — exactly right for a
  pure-string emitter consumed at CLI time.
