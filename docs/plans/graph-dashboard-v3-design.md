---
status: implemented
last_verified: 2026-05-17
title: "graph Tool — v0.3 dashboard design"
audience: [contributors, plugin-authors]
purpose: "Interactive Code Paths dashboard panel — answers exploratory questions the CLI can't. Builds on top of v0.2's catalog and indexes; no engine changes."
related-docs:
  - ./graph-tool-v2-design.md
  - ../architecture/60-surfaces/03-dashboard.md
---
# `graph` Tool — v0.3 dashboard design

A clean upgrade from v0.2: the engine is unchanged. v0.3 ships an interactive Code Paths panel in the existing dashboard, exposing the catalog as something a developer can explore with a mouse instead of grep.

> **What this is for.** The CLI surface is for *gates* (does this fail?). The dashboard is for *exploration* (what's here?). v0.2 nailed the gate; v0.3 builds the exploration layer.

> **What this is not for.** Stats. Reports. Run-once-and-close. Every interaction in the panel must answer a real developer question with a clear next step. If a view doesn't pass the "why would someone look, what would they do" filter, it's not in v0.3.

> **No backwards compatibility.** v0.3 *replaces* v0.2's thin findings-list Code Paths panel. There are no adapters, no feature flags, no migration shims. The existing `code-paths.ts` content (~64 LOC of findings-list rendering) is deleted in Phase P0 and rewritten across the phases below.

---

## 1. The filter

Every interaction in this panel must satisfy two questions:

1. **Why would someone look at this?** A concrete, named scenario — "I'm new to the codebase," "I'm refactoring this feature," "this function broke production."
2. **What would they do next?** A concrete action — "click into the function's callers," "read the body in context," "open the file in editor."

Views that fail either filter don't ship in v0.3. Stats-style ("show me a histogram of function sizes") doesn't pass either filter on its own — *unless* clicking a bar drills into actionable detail.

The seven views in §3 each pass both filters explicitly, and the rationale is documented per view.

---

## 2. Architecture

### 2.1 The catalog is the API

v0.2 already persists a complete catalog at `<project>/opensip-tools/.runtime/cache/graph/catalog.json`. The dashboard reads this file at HTML-generation time and embeds it as an inline JSON blob. No new backend, no API server, no new file format.

```
┌─────────────────────────────────────────────────────────────┐
│  graph CLI run                                               │
│    → catalog.json (5,000–50,000 functions)                   │
│    → session.json (run summary)                              │
│    → report/index.html (existing dashboard, with new panel)  │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼ (user opens the HTML)
┌─────────────────────────────────────────────────────────────┐
│  Browser (offline, no server)                                │
│    Code Paths panel reads embedded catalog + session.        │
│    All filtering, sorting, drilldown is client-side JS.      │
└─────────────────────────────────────────────────────────────┘
```

This preserves the dashboard's current portability property: you can email the report directory to a teammate and the panel works.

### 2.2 No new package

All v0.3 code lives in `packages/contracts/src/persistence/dashboard/code-paths.ts` and a directory of sibling files for sub-components (`packages/contracts/src/persistence/dashboard/code-paths/`). The graph engine package is unchanged.

The HTML generator at `packages/contracts/src/persistence/dashboard/generator.ts` already pulls in `code-paths.ts`'s output via `dashboardCodePathsJs()`. v0.3 expands what that file produces and adds one new generator parameter (`graphCatalog: GraphCatalog | null`) that the catalog gets embedded from.

### 2.3 The data flow

1. `opensip-tools graph` runs. Stages 1+2 produce a catalog. Rules produce signals. The session writer persists the session record (which includes findings).
2. `opensip-tools dashboard` (or `opensip-tools graph --open`) regenerates the static HTML. The dashboard CLI reads `catalog.json` if present and passes the parsed object to `generateDashboardHtml(...)`.
3. The generator embeds two blobs:
   - `<script type="application/json" id="sessions-data">` — already exists.
   - `<script type="application/json" id="graph-catalog">` — new in v0.3.
4. The Code Paths panel JS reads those blobs at page load and renders interactive views.

The catalog is large (~12 MB on opensip-tools, larger on real monoliths). The dashboard already serves multi-MB inline JSON; this is consistent. If catalog size becomes a usability problem, v0.4 can move to an out-of-band fetch — but for v0.3, inline is fine.

### 2.4 Decoupling

The same architectural rules from v0.2 apply:

- **`code-paths.ts` does not import from `@opensip-tools/graph`.** It consumes the catalog by JSON shape only. The catalog shape is duplicated as a structural type alias (`GraphCatalog`) inside `code-paths/types.ts`. This is intentional decoupling.
- **No framework dependency.** The existing dashboard uses vanilla DOM manipulation. v0.3 does the same. No React, no Vue, no D3.
- **`code-paths.ts` may import shared dashboard helpers.** It uses `el()` from `shared.ts`, CSS classes from `css.ts`, the existing tab system patterns. It does not invent new framework primitives.
- **Per-view JS lives in sub-files.** Imported by `code-paths.ts`'s top-level `dashboardCodePathsJs()`.

### 2.5 Architectural invariants (codebase-specific)

These invariants are non-negotiable and codified in CLAUDE.md, the dep-cruiser config, and the fitness-check set. Every phase below must respect them; the dep-cruiser additions and fitness checks listed in §9 enforce them mechanically.

| # | Invariant | Where enforced |
|---|---|---|
| AI-1 | All v0.3 code lands in `@opensip-tools/contracts` (Layer 2). No new package. | dep-cruiser layer rules (already in place); §6 module layout. |
| AI-2 | `@opensip-tools/contracts` `package.json` `dependencies` delta = 0. No React, Vue, Svelte, D3, or any UI/graph library. `devDependencies` may add `jsdom` if not already a workspace dev dep. | New fitness check `dashboard-no-ui-framework-deps`; manual review of `package.json` diff. |
| AI-3 | `code-paths.ts` and every file under `code-paths/` MUST NOT import from `@opensip-tools/graph`. The JSON shape is duplicated as a structural type alias. | New dep-cruiser rule `dashboard-no-graph-import` (§9). |
| AI-4 | New CSS extends `dashboard/css.ts` (a function returning a CSS string). No new stylesheet system, no separate `.css` file. | New dep-cruiser rule `dashboard-no-side-stylesheets` (§9) bans `.css` imports from contracts. |
| AI-5 | DOM access uses vanilla `document.querySelector`, `innerHTML` template strings, and the existing `el()` helper from `shared.ts`. No virtual DOM, no template engine. | Code review; reuse-of-`el()` is verified by Phase 4 (DRY) of the pipeline review. |
| AI-6 | Logging conventions follow the `evt: 'graph.dashboard.<action>'` shape if the panel ever logs. v0.3 should log nothing in the browser path; the only logger calls are in `dashboard.ts` (fitness CLI) for the catalog-load happy/sad path: `evt: 'graph.dashboard.catalog.load'` and `evt: 'graph.dashboard.catalog.parse-error'`. | Code review; mirrored against existing `evt: 'graph.*'` events in `@opensip-tools/graph`. |
| AI-7 | Inline data uses `<script type="application/json" id="...">` blocks (matching v0.2's `id="sessions-data"`). No new transport, no `fetch()`, no out-of-band asset. | Code review; Phase P0 generator test asserts the block id. |
| AI-8 | Test runner is vitest with jsdom. Test files: `*.test.ts` colocated under `packages/contracts/src/__tests__/`. No jest, no separate test app. | `packages/contracts/vitest.config.ts` already configured. |

### 2.6 Module-isolation invariants (within `code-paths/`)

These extend the existing v0.2 `graph-stage-isolation` discipline into the dashboard. Every dep-cruiser rule below is added to `.dependency-cruiser.cjs` in Phase P0.

| # | Invariant | Rule name (§9) |
|---|---|---|
| MI-1 | Files under `code-paths/` cannot import from any package other than `@opensip-tools/contracts` itself and Node built-ins. They are pure JS-string emitters; they have no runtime dependencies. | `dashboard-code-paths-self-contained` |
| MI-2 | `code-paths/view-*.ts` files cannot import each other. They share state only through `views-registry.ts` (the registered `View[]`) and through the singleton `filterState` and `indexes` exposed at panel-init. | `dashboard-views-disjoint` |
| MI-3 | `code-paths/scc.ts`, `code-paths/search.ts`, `code-paths/trace.ts` are pure-algorithm modules. They cannot import from `view-*` or `function-card.ts`. | `dashboard-algorithms-no-view-deps` |
| MI-4 | `code-paths/types.ts` is type-only. It MUST NOT export any runtime value. | `dashboard-types-type-only` (manual rule via `eslint-plugin-import` `no-unused-modules` + a custom check; no dep-cruiser equivalent — flagged for code review). |
| MI-5 | Every `view-*.ts` file MUST export exactly one symbol: `dashboardView<Name>Js(): string`. Mirrors the v0.2 `Renderer` discipline. | New fitness check `dashboard-view-single-export`. |

---

## 3. The seven views

Each view answers a real developer question. Each has a clear "click → drill down" path. None is a static stat dump.

### View 1 — "Hot functions"

**Why someone looks:** "I'm about to change `logger`. Who else depends on it?" Or: "I'm onboarding to this codebase. What's the load-bearing infrastructure?"

**What they do:** Click a hot function → Function Card opens with its callers (file:line, ranked by package) → click a caller → recurse.

**Layout:**

```
┌─ Hot functions (most callers) ──────────────────────┐
│  [filter: All packages ▼] [sort: callers ▼]         │
│                                                      │
│  Function              Callers   File                │
│  ──────────────────────────────────────────────      │
│  logger                  147     core/lib/logger.ts  │
│  defineCheck              89     fitness/.../...     │
│  resolveProjectPaths      72     core/lib/paths.ts   │
│  EXIT_CODES               64     contracts/...       │
│  ... (top 50)                                         │
│                                                      │
│  [click any row to expand]                            │
└──────────────────────────────────────────────────────┘
```

**Data sources:** computed at panel-init time from `catalog.functions[*]` by reversing `calls[].to[]`. Equivalent to v0.2's `Indexes.callers`, but recomputed in the browser (the catalog is the only persisted shape; the v0.2 `Indexes` map is rebuilt from it). See §4.5.

### View 2 — "Big functions"

**Why someone looks:** "I'm reading this file to understand it. What's the longest function here?" Or: "Code review — what should I split?"

**What they do:** Click a big function → Function Card with callers + callees + body length → decide if it should be refactored. Click "open in editor" if the editor integration is wired.

**Layout:** Same shape as View 1, sorted by `endLine - line`. Filter by package, by kind (function/method/arrow). Top 30.

**Data sources:** Catalog directly (no index needed; iterate functions, sort by size).

### View 3 — "Wide functions"

**Why someone looks:** "What functions take too many parameters? Are there any I should refactor to take a config object?"

**What they do:** Click a wide function → Function Card with the parameter list → decide if a refactor is warranted.

**Layout:** Top 20 by `params.length`, descending. Show a thumbnail of the parameter list inline (e.g. `(output, baselinePath, options, retry, timeout, ...)`).

**Data sources:** Catalog `params` field. No index.

### View 4 — "Package coupling heat map"

**Why someone looks:** "What does our architecture actually look like? Which packages call which?" Or: "Is `core` really the bottom layer?"

**What they do:** See the matrix. Spot unexpected dependencies. Click a cell → Function Card list of the actual call sites that produced the count → decide if a layer rule should be added or a refactor is needed.

**Layout:**

```
        core  contracts  cli  fitness  simulation  graph  lang-*  checks-*
core      —      —        —     —          —         —       —        —
contracts ✓      —        —     —          —         —       —        —
cli       ✓      ✓        —     ✓          ✓         ✓       ✓        —
fitness   ✓      ✓        —     —          —         —       ✓        —
graph     ✓      ✓        —     —          —         —       ✓        —
...
```

Cells colored by call density. Empty cells mean "no calls in this direction." Click a cell → see the top-N call sites between those packages (each is a clickable function → Function Card).

**Data sources:** Iterate every `calls[i].to` in the catalog; for each (caller-package, callee-package) pair, count. Package is derived from `filePath` (regex against `^packages/([^/]+)/`). Heat shading is text-color-only (no SVG).

### View 5 — "Untested production code"

**Why someone looks:** "Where am I missing tests? What's the highest-risk untested function?"

**What they do:** See production functions with no caller from any test file. Sort by `inboundCallCount` descending — most-called untested functions are the highest-risk gaps. Click → Function Card.

**Layout:** Sortable table. Function name, file, callers count (production-side), kind. Filter by package.

**Note:** Different from coverage tools (which measure line coverage at runtime). This view measures *static reachability from test code*. It catches things that *have a test* via dynamic dispatch but don't have a *static call*. Conservative — false positives possible — but cheap and uses only catalog data.

**Data sources:** Catalog `inTestFile` flag + browser-built callers map (§4.5).

### View 6 — "Strongly-connected components"

**Why someone looks:** "Is there code in this codebase that's tangled — a cluster of functions that all call each other? If so, where's the tightest knot?"

**What they do:** See SCCs of size > 1. Each is a cluster of functions in a mutual-recursion or reciprocal-dispatch shape. Click into the SCC → see all functions in the cluster (each clickable → Function Card) → understand if it's intentional (e.g. a mutually-recursive parser) or accidental.

**Layout:** Sorted by component size descending. Top 10 components. Each row: size, member functions (preview), package(s) involved.

**Note:** SCCs of size 1 (every function is its own SCC) are not shown. Only size ≥ 2 — the actual coupling shape.

**Data sources:** Tarjan's SCC algorithm over the call graph. ~100 LOC of standard graph code, runs in O(V + E). Implemented in `code-paths/scc.ts`.

### View 7 — "Function search"

**Why someone looks:** "I want to find a function by name and explore its surroundings — callers, callees, file."

**What they do:** Type a name. Get a list. Click → Function Card.

**Layout:** A search box at the top of the panel (sibling to the tab bar — always visible across views). Types fuzzy-match against `simpleName` and `qualifiedName`. Results show top 20 matches. Empty search shows "type to search" placeholder.

**Note:** This isn't a separate "view" so much as a search-bar always-visible component on the panel. It's a fast path to drill into any specific function without scrolling. Implemented as both a top-of-panel input *and* a tab labelled "Search" so keyboard-first users can land on it.

**Data sources:** A browser-built `bySimpleName` map (§4.5).

---

## 4. The shared interaction model

Across all 7 views, the same patterns apply:

### 4.1 Universal "Function Card"

Every clickable function name (in any view) opens a Function Card overlay. The Function Card has a fixed structure:

```
┌─ resolveProjectPaths ───────────────────[×]┐
│  packages/core/src/lib/paths.ts:78          │
│  Body: 19 lines · function · exported       │
│  Params: projectDir                          │
│  Returns: ProjectPaths                       │
│                                              │
│  ── Callers (72) ─────────────────────────  │
│  ▸ packages/cli/src/index.ts:212             │
│  ▸ packages/fitness/.../tool.ts:118          │
│  ▸ ... (collapsible per package)             │
│                                              │
│  ── Callees (3) ──────────────────────────  │
│  ▸ join (node:path) — external               │
│  ▸ realpathSync — external                   │
│  ▸ existsSync — external                     │
│                                              │
│  [open in editor] [trace from entry point]   │
└─────────────────────────────────────────────┘
```

This is the universal drill-down. Every "click a function" action opens this card. Closing the card returns to the prior view. **One module, one DOM node, opened/closed by every view via a shared API** (see §6 module layout).

### 4.2 "Trace from entry point"

A button on the Function Card that runs a BFS from the inferred entry-point set down to the current function and shows the shortest path. Answers "how does code actually reach this function?" in one query.

If multiple entry points reach this function, the user sees the shortest path; a "show all paths" expansion shows others. Implemented in `code-paths/trace.ts`.

### 4.3 Filter chips

Across most views, the same filter chips at the top:

- Package multi-select
- Kind filter (function / method / arrow / constructor / getter / setter / module-init)
- Production/test toggle (default: production only)

Filters apply to the visible view; closing a Function Card and reopening another applies the same filters. The filter state is held in a single shared object owned by `code-paths/filters.ts`; views subscribe to it.

### 4.4 Editor deep-link

A button on the Function Card that produces a `vscode://file/<path>:<line>` URL (and similar for other editors). Clicking the button opens the editor. The protocol used is configurable in `opensip-tools.config.yml` under `dashboard.editor`. If unset, the button copies the path to clipboard instead.

The protocol is read at HTML-generation time and embedded into the page as a constant in the inlined script. Implemented in `code-paths/editor-link.ts`.

### 4.5 Browser-built indexes

The catalog persists only `functions[name][i].calls[].to[]`. v0.2's `Indexes` (`byBodyHash`, `bySimpleName`, `callees`, `callers`) is in-memory only and is *not* persisted. The Code Paths panel rebuilds these in the browser at panel-init time, in a single linear scan.

This is implemented once in `code-paths/indexes.ts` and exported as `buildIndexes(catalog) → Indexes`. Every view consumes `Indexes` (not the raw catalog) for caller/callee lookups.

---

## 5. What's NOT in v0.3

Calling out what we deliberately defer:

- **Server-side queries.** The dashboard stays static. If catalog size becomes prohibitive, v0.4 introduces a localhost server.
- **Time-series / commit-history views.** Compare-runs-across-time was sketched in earlier conversations but requires multi-commit catalogs, a comparison engine, and UI for the time dimension. v0.4+.
- **Side-effect overlay.** "Color the call graph by side effects" requires the side-effect taxonomy from rule P5 to be wired more than it is. v0.4.
- **Editor integration as a deep VS Code extension.** v0.3 just emits a deep link; a real extension is its own product.
- **Custom user views.** No user-authored dashboard panels yet. The seven views are first-party.
- **Visualizing the full call graph.** No 3D force-directed view, no SVG node graph. Those are pretty but rarely useful at scale (a 5,000-node graph is unreadable). The seven curated views above answer specific questions; visualization for visualization's sake doesn't pass the filter.
- **Dashboard analytics.** No usage tracking, no telemetry. The dashboard is local-only.

---

## 6. Module layout

Inside `packages/contracts/src/persistence/dashboard/`:

```
code-paths.ts                    # Top-level panel — orchestrates init, embeds data, dispatches to views
code-paths/
  types.ts                       # GraphCatalog, FunctionOccurrence, CallEdge, Indexes — JSON-shape types
  indexes.ts                     # buildIndexes(catalog) → Indexes (browser-side recompute of v0.2 Indexes)
  filters.ts                     # Shared filter-chip state + chip rendering
  function-card.ts               # The universal drill-down overlay (opened by every view)
  editor-link.ts                 # Deep-link generation
  trace.ts                       # BFS from entry-point set to a target function
  scc.ts                         # Tarjan's algorithm
  search.ts                      # Fuzzy match (algorithm + ranking)
  view-hot.ts                    # View 1
  view-big.ts                    # View 2
  view-wide.ts                   # View 3
  view-coupling.ts               # View 4 (heat map)
  view-untested.ts               # View 5
  view-sccs.ts                   # View 6
  view-search.ts                 # View 7
  views-registry.ts              # exports the View[] list (consumed by code-paths.ts dispatcher)
shared.ts                        # (existing — unchanged)
css.ts                           # (existing — extended with code-paths-specific classes)
generator.ts                     # (existing — extended with one parameter: graphCatalog)
```

~16 new files, each ≤200 LOC. Total ~1,500–2,000 LOC of vanilla TS that compiles to inline JS in the static HTML.

Each new TS file lives at compile-time as a normal module that exports a `dashboardCodePaths<X>Js(): string` (or a sub-piece) returning a JS string. The strings are concatenated by `code-paths.ts::dashboardCodePathsJs()` and emitted into the page's `<script>` block by `generator.ts`.

---

## 7. Implementation phases

Phases are ordered by **strict dependency**. Each phase ends with the new functionality wired into the dashboard generator and visible in the rendered HTML. A phase that introduces a class or module with no caller is **incomplete**.

### Phase P0 — Skeleton, generator wiring, panel scaffold (1 PR)

**Goal.** Replace the v0.2 thin findings-list panel with an empty interactive scaffold. Every later phase fills in one piece without ever touching `generator.ts` again.

**Prerequisites.** v0.2 of `@opensip-tools/graph` is on main (✓ shipped).

**Steps.**

1. **Delete the existing thin panel.** `packages/contracts/src/persistence/dashboard/code-paths.ts` is rewritten end-to-end. The 64-LOC findings-list version is removed; no part of it survives.
2. **Add the catalog parameter to the generator.**
   - `packages/contracts/src/persistence/dashboard/generator.ts::generateDashboardHtml(...)` gains a fourth optional parameter: `graphCatalog: GraphCatalog | null = null`.
   - When non-null, the generator emits a `<script type="application/json" id="graph-catalog">…</script>` block (escape-sanitized via the existing `escapeForScriptContext`).
   - When null, no block is emitted; the panel renders the "no catalog yet" empty state.
3. **Plumb the catalog through the dashboard CLI.**
   - `packages/fitness/engine/src/cli/dashboard.ts::openDashboard(...)` reads `<paths.graphCatalogPath>` if it exists (`existsSync`), parses it, passes it as the new fourth argument. On parse error, log a warning and pass `null`.
   - `packages/contracts/src/persistence/store.ts` exports a structural type `GraphCatalog` (just the JSON shape — see §6 `code-paths/types.ts`). The dashboard CLI imports `GraphCatalog` and casts the parsed JSON to it.
4. **Create the panel skeleton.**
   - `code-paths.ts::dashboardCodePathsJs()` emits a `renderCodePathsTab()` function that:
     - Reads the embedded `#graph-catalog` JSON blob (or shows the empty state if missing).
     - Builds the browser-side `Indexes` via `buildIndexes(catalog)` (Phase P1 fills this in; Phase P0 stubs it returning empty maps).
     - Renders the persistent search input, the filter chip bar, the view tab bar, and the seven empty view containers (each with class `code-paths-view`, ids `code-paths-view-hot`, etc.).
     - Wires tab clicks to show/hide containers (mirror of `shared.ts`'s tab-bar handler).
   - The seven views render the placeholder text "Coming in Phase P<N>" until their phase lands.
5. **Add the new generator-level wiring tests.**
   - Extend `packages/contracts/src/__tests__/dashboard.test.ts` with a test that calls `generateDashboardHtml([], [], [], null)` and asserts no `id="graph-catalog"` block is present.
   - Add a test that calls it with a synthetic catalog and asserts the JSON blob is present and parseable.
6. **CSS extension.** Add the `.code-paths-view`, `.code-paths-tabs`, `.code-paths-search`, `.code-paths-filter-chips`, and `.function-card-overlay` classes to `dashboard/css.ts`. They mirror existing `.tab`/`.subtab`/`.card`/`.muted` patterns; no new design language.
7. **Dep-cruiser rules.** Add the rules from §9.1 to `.dependency-cruiser.cjs`. CI fails if any new code violates them.
8. **Fitness checks.** Add `dashboard-no-ui-framework-deps` and `dashboard-view-single-export` to `@opensip-tools/checks-typescript`. Register them in the `architecture` recipe.

**Acceptance.**

- `pnpm --filter=@opensip-tools/contracts build` succeeds.
- `pnpm --filter=@opensip-tools/contracts test` passes including the two new generator tests.
- Existing dashboard tests pass.
- `pnpm lint` (eslint + dep-cruiser) is 0-error including the new rules from §9.1.
- The two new fitness checks from §9.2 pass against opensip-tools itself.
- Running `opensip-tools dashboard` against opensip-tools itself produces an HTML file with the empty Code Paths panel skeleton, search bar, and 7 empty view tabs.

### Phase P1 — Browser-side Indexes + types

**Goal.** `code-paths/types.ts` and `code-paths/indexes.ts` exist; every later phase consumes `Indexes` (not the raw catalog).

**Steps.**

1. Create `code-paths/types.ts`. Define `GraphCatalog`, `FunctionOccurrence`, `CallEdge`, `Param`, `Indexes` as readonly structural types matching v0.2's `catalog.json` shape (see [`graph-tool-v2-design.md`](./graph-tool-v2-design.md) §2.2 and §7). These are *type-only* — no runtime code.
2. Create `code-paths/indexes.ts`. Export `dashboardIndexesJs(): string` that emits a JS function `buildIndexes(catalog)` performing four linear passes (`byBodyHash`, `bySimpleName`, `callees`, `callers`). Same algorithm as v0.2's `pipeline/indexes.ts`, ported to JS.
3. **Wire into `code-paths.ts`.** The panel's `renderCodePathsTab()` calls `buildIndexes(catalog)` once at init and stores the result in a closure variable `indexes` accessible to every view.
4. Re-export `GraphCatalog` (and the related types) from `packages/contracts/src/index.ts`'s public barrel — so `dashboard.ts` (in fitness) can `import type { GraphCatalog }`.

**Acceptance.**

- The skeleton from P0 still renders.
- `buildIndexes` is called at panel-init in the rendered HTML (verified by a unit test in P1's test bucket — see §7 Phase T).

### Phase P2 — Function Card (universal overlay)

**Goal.** The Function Card overlay exists, opens, closes, and renders correct content for any `bodyHash`. All later view phases use it.

**Steps.**

1. Create `code-paths/function-card.ts`. Export `dashboardFunctionCardJs(): string`. The emitted JS exposes:
   - `openFunctionCard(bodyHash: string)` — looks up the occurrence in `indexes.byBodyHash`, builds the card DOM, appends to body, focuses close button.
   - `closeFunctionCard()` — removes the overlay node.
   - The card includes: name + location, body length, kind, visibility, params, returnType, callers (grouped by package), callees (resolved + external), an "open in editor" button (Phase P8), a "trace from entry" button (Phase P9).
2. Create `code-paths/editor-link.ts` (stub for P8). Exports `editorLinkUrl(filePath, line)` returning `null` initially. P8 fills it in.
3. Create `code-paths/trace.ts` (stub for P9). Exports `traceFromEntry(bodyHash)` returning `null` initially. P9 fills it in.
4. **Wire into the panel.** `code-paths.ts` includes the function-card JS string in its concatenation. The panel registers a delegated click handler on `.code-paths-view-container` that dispatches `openFunctionCard(targetBodyHash)` when a `[data-body-hash]` element is clicked.
5. **Integrate with the placeholder views.** Each placeholder view registers one stub link (e.g. "Click to open card for first function in catalog") so the Function Card flow is exercised end-to-end before the real views land.

**Acceptance.**

- The placeholder click on any of the 7 view tabs opens the Function Card overlay with correct content.
- Clicking a caller in the card opens *another* Function Card (recursion works).
- Pressing Escape closes the card.

### Phase P3 — Filter chips + view registry

**Goal.** A shared filter state and a typed view registry, so every later view phase plugs in by registering a `View` object.

**Steps.**

1. Create `code-paths/filters.ts`. Exports `dashboardFiltersJs(): string`. The emitted JS:
   - Holds a singleton `filterState = { packages: Set<string>, kinds: Set<Kind>, includeTests: false }`.
   - Renders the filter chip DOM into the `.code-paths-filter-chips` element.
   - On any chip change, calls `notifyViews()`, which iterates the current view registry and invokes each view's `render()`.
2. Create `code-paths/views-registry.ts`. Exports a JS-string-emitter that registers a `views = []` array. Every view phase pushes a `{ id, label, render(container, catalog, indexes, filterState) }` entry.
3. **Wire into the panel.** `code-paths.ts` initializes filters once, then populates the tab bar from `views.map(v => v.id/label)`, dispatches tab clicks to `views[i].render(...)`.
4. **Tab routing.** The persistent search input updates the URL hash to `#code-paths/search` and selects the "search" view tab; opening a view tab updates the hash. This makes views deep-linkable.

**Acceptance.**

- Filter chips render at the top of the panel.
- Toggling a chip re-renders the active view (still placeholder content from P0).
- Clicking a view tab activates the right container.

### Phase P4 — View 1 (Hot functions)

**Goal.** Hot Functions view fully rendered, sortable, filterable, drill-into-card.

**Steps.**

1. Create `code-paths/view-hot.ts`. Exports `dashboardViewHotJs(): string`. The emitted JS exports a `View` named `"hot"` and pushes it into `views`.
2. The view's `render(container, catalog, indexes, filterState)`:
   - Reads `indexes.callers`, sorts function occurrences by inbound count desc, slices top 50.
   - Applies `filterState` (package set, kind set, test/prod toggle).
   - Renders an HTML table with `data-body-hash` on each row.
   - Click delegates to `openFunctionCard`.
3. **Wire into views-registry.** The view's pushed entry replaces the placeholder for the "hot" tab.

**Acceptance.**

- Top 50 functions sorted correctly against the opensip-tools dogfood catalog.
- Clicking a row opens a Function Card with correct caller count.
- Toggling the package filter re-renders the table with the package filtered out.

### Phase P5 — View 2 (Big) + View 3 (Wide)

**Goal.** Two more views, same `View` shape as Hot.

**Steps.**

1. Create `code-paths/view-big.ts`, push `View "big"` into `views`. Sort by `endLine - line` desc; render top 30; click → card.
2. Create `code-paths/view-wide.ts`, push `View "wide"` into `views`. Sort by `params.length` desc; render top 20; show param thumbnails inline; click → card.
3. **Wire into views-registry.** Both views register themselves; their tabs become live.

**Acceptance.**

- Both views render against the opensip-tools dogfood catalog.
- Filter chips affect both.

### Phase P6 — View 4 (Coupling heat map)

**Goal.** Package coupling matrix, click-cell drill-down.

**Steps.**

1. Create `code-paths/view-coupling.ts`, push `View "coupling"`.
2. The view computes a `Map<callerPkg, Map<calleePkg, count>>` once per render (filterable view of the catalog). Renders a table of cells; cell color is text-shaded via a `--coupling-density` CSS custom property.
3. Click handler: opens a Function Card list of the top-N call sites for that (caller, callee) pair. (The card's content is the callers-of-the-callee filtered to caller-pkg.)
4. **Wire.** Push to `views`.

**Acceptance.**

- Matrix renders with N×N cells where N = packages-in-catalog.
- Cell click opens a Function Card list.

### Phase P7 — View 5 (Untested) + View 6 (SCCs)

**Goal.** Two more views.

**Steps.**

1. Create `code-paths/view-untested.ts`, push `View "untested"`. Filter `catalog.functions[*]` where `inTestFile === false` and zero of `indexes.callers[bodyHash]` are in `inTestFile === true` files.
2. Create `code-paths/scc.ts` with Tarjan's algorithm (~100 LOC pure function). Export as a JS string emitter.
3. Create `code-paths/view-sccs.ts`, push `View "sccs"`. Calls Tarjan over the call graph, filters `size ≥ 2`, renders top 10.
4. **Wire.** Both views push into `views`.

**Acceptance.**

- Untested view renders against the dogfood catalog.
- SCC view renders (may be empty for opensip-tools — that's fine; the test fixtures include synthetic cycles).

### Phase P8 — View 7 (Search)

**Goal.** Fuzzy search box + dedicated view tab.

**Steps.**

1. Create `code-paths/search.ts` — pure fuzzy-match function `(query: string, names: string[]) => Match[]`. Algorithm: substring-with-character-skip; scoring rewards prefix matches and exact-case matches. (Locked in Phase 6 ADRs.)
2. Create `code-paths/view-search.ts`, push `View "search"`. The view binds to the persistent search input *and* renders a results table inside the search tab.
3. **Wire.** The persistent search input lives at the top of the panel (added in P0); P8 attaches the input handler. Typing updates `view-search`'s state and switches to the search tab.

**Acceptance.**

- Typing "logger" matches `logger`, `Logger`, `logRequest`, etc.
- Clicking a result opens a Function Card.

### Phase P9 — Editor deep-link + trace from entry

**Goal.** The two action buttons on the Function Card become live.

**Steps.**

1. Fill in `code-paths/editor-link.ts`: read `dashboard.editor` from a config-derived constant injected by `generator.ts` (new generator parameter `editorProtocol: string | null`). The dashboard CLI passes the value from `opensip-tools.config.yml`.
   - Update `packages/contracts/src/persistence/dashboard/generator.ts` to accept `editorProtocol` and emit it as a JS constant in the inlined script.
   - Update `packages/fitness/engine/src/cli/dashboard.ts` to read the config and pass the value.
2. Fill in `code-paths/trace.ts`: BFS from the inferred entry-point set to a target `bodyHash`, returning the shortest path. Entry-point inference reuses v0.2's heuristic: any function in `packages/cli/src/index.ts` or any function with no callers AND `visibility === 'exported'`.
3. **Wire.** Both Function Card buttons become enabled. "Open in editor" opens the URL or copies the path. "Trace from entry" replaces the card body with the path.

**Acceptance.**

- With `dashboard.editor: vscode` in config, clicking "open in editor" produces a `vscode://file/<abs>:<line>` URL.
- "Trace from entry" finds a path for any function reachable from the inferred entry-point set.

### Phase T — Tests (full coherent inventory)

**Goal.** Complete unit-test coverage organized so every prior phase's test obligation is grouped and resolvable. No `.skip(...)`, no `.todo(...)` left as load-bearing — placeholder tests would mask gaps.

**Test files — by source phase.** Every test below corresponds to a source-of-truth section and a pipeline phase. The grouping makes "what's missing" trivially auditable.

#### From §7 implementation phases (P0–P9)

**`packages/contracts/src/__tests__/dashboard-generator-graph-catalog.test.ts`** (P0, P9)

- `generateDashboardHtml([], [], [], null)` → no `id="graph-catalog"` block.
- `generateDashboardHtml([], [], [], catalog)` → block present and parseable JSON equal to `catalog`.
- `generateDashboardHtml([], [], [], catalog, 'vscode')` (P9) → editor protocol embedded as a JS constant.

**`packages/contracts/src/__tests__/dashboard-indexes.test.ts`** (P1)

- `buildIndexes(syntheticCatalog)` produces correct `byBodyHash`, `bySimpleName`, `callees`, `callers`. Five-function fixture; assert all four maps row-by-row.
- Empty-catalog edge case: empty maps, no errors.
- Polymorphic call edge case: a single `CallEdge.to` array of length 3 produces three entries in `callers` for that function.

**`packages/contracts/src/__tests__/dashboard-function-card.test.ts`** (P2)

Function-shape coverage (the §8 acceptance gate's "5 different shapes"):

- `function-declaration` — opens, shows declared name, params, return type.
- `method` — shows enclosing class.
- `arrow` — shows synthesized `<arrow:...>` name.
- `getter` — kind label rendered as "getter".
- `constructor` — kind label rendered as "constructor".

Behavior:

- Function with N callers (synthetic 7) — callers list shows 7 rows grouped by package.
- Function with 0 callers — callers section shows the "no callers" empty state.
- Function with polymorphic edges (single `CallEdge.to.length === 3`) — callees list shows three resolved entries, each clickable.
- Open-then-recurse: clicking a caller opens a *new* card; only one overlay in DOM at a time (validates §10.2).
- Escape closes; close-button click closes; click-outside closes.

**`packages/contracts/src/__tests__/dashboard-filters.test.ts`** (P3)

- Toggling a package chip removes that package's rows from the active view.
- Toggling kind chips works the same way.
- Production/test toggle defaults to "production only"; flipping shows test-only entries.
- (Cross-link to `filter-observer.test.ts` from §10.6 — that test asserts the observer dispatch; this one asserts the filter *predicates* work per-view.)

**`packages/contracts/src/__tests__/dashboard-view-hot.test.ts`** (P4)

- Top 50 sorted by `indexes.callers[bodyHash].length` desc.
- Click row → `openFunctionCard` invoked with that row's `bodyHash`.
- Empty catalog → empty state.

**`packages/contracts/src/__tests__/dashboard-view-big.test.ts`** and **`dashboard-view-wide.test.ts`** (P5)

- Big: top 30 sorted by `endLine - line` desc.
- Wide: top 20 sorted by `params.length` desc; param thumbnails formatted correctly.

**`packages/contracts/src/__tests__/dashboard-view-coupling.test.ts`** (P6)

- Synthetic catalog with two packages and three cross-package edges → matrix has the right cell values.
- Cell click opens a Function Card list of the call sites.
- `packageOfPath('packages/contracts/src/index.ts') === 'contracts'` (cross-link to `path-utils.test.ts`).

**`packages/contracts/src/__tests__/dashboard-view-untested.test.ts`** (P7)

- Function with all callers in `inTestFile === false` files → not listed.
- Function with at least one test caller → not listed (it has a test).
- Function with no callers at all → listed.
- Function with one production-only caller → listed.

**`packages/contracts/src/__tests__/dashboard-scc.test.ts`** (P7)

- Tarjan correctness:
  - Cycle of 2 (`a → b → a`) → one SCC of size 2.
  - Cycle of 3 (`a → b → c → a`) → one SCC of size 3.
  - Two disjoint SCCs (`a ↔ b`, `c ↔ d`) → two SCCs.
  - Isolated nodes (no edges) → no SCCs reported (size-1 omitted by view).
  - Empty graph → no SCCs.

**`packages/contracts/src/__tests__/dashboard-view-sccs.test.ts`** (P7)

- View renders top 10 SCCs only.
- Each row shows size, member preview, package labels.

**`packages/contracts/src/__tests__/dashboard-search.test.ts`** (P8)

- Prefix match: `"log"` matches `logger` (high score).
- Mid-word match: `"ger"` matches `logger` (lower score).
- No match: `"xyz"` returns empty.
- Case-insensitive by default; exact-case rewards score.
- Empty query → no results (placeholder shown).

**`packages/contracts/src/__tests__/dashboard-view-search.test.ts`** (P8)

- Typing into the persistent search input updates the search-tab results.
- Typing also auto-switches to the search tab.
- Click result → `openFunctionCard`.

**`packages/contracts/src/__tests__/dashboard-editor-link.test.ts`** (P9)

- Config `dashboard.editor: vscode` → `editorLinkUrl(filePath, line)` returns `vscode://file/<filePath>:<line>`.
- Config unset → returns `null`; button copies path to clipboard.
- Config `dashboard.editor: cursor` → `cursor://...`.
- Config with malformed value → `null` (defensive).

**`packages/contracts/src/__tests__/dashboard-trace.test.ts`** (P9)

- BFS finds shortest path from inferred entry-point set to a target `bodyHash`.
- Multiple paths exist → shortest is returned.
- No path exists → `null` returned; the card shows "no path from any entry point."

#### From §9 (Phase 2 — architectural assertions)

**`packages/contracts/src/__tests__/dashboard-arch.test.ts`** (Phase 2)

- Synthetic violation: a fixture file under `code-paths/` imports `@opensip-tools/graph` → `dashboard-no-graph-import` fires.
- Synthetic violation: `view-x.ts` imports `view-y.ts` → `dashboard-views-disjoint` fires.
- Synthetic violation: a contracts file imports `react` → `dashboard-no-ui-framework` fires.
- Synthetic violation: a contracts file imports `foo.css` → `dashboard-no-side-stylesheets` fires.

**`packages/checks-typescript/src/__tests__/dashboard-fitness-checks.test.ts`** (Phase 2)

- `dashboard-no-ui-framework-deps` against a passing fixture (no UI deps) and a failing fixture (lists `react` in `dependencies`).
- `dashboard-view-single-export` against a passing fixture (one named export of the right shape) and three failing fixtures (zero exports / two exports / wrong-name export).

#### From §10 (Phase 3 — pattern-seam tests)

**`packages/contracts/src/__tests__/dashboard-view-conformance.test.ts`** (§10.1)

- For each registered `View` in the rendered HTML's `views` array: `id` is one of `'hot' | 'big' | 'wide' | 'coupling' | 'untested' | 'sccs' | 'search'`; `label` is non-empty; `render` is a function. Validates §10.1's compile-time invariant at runtime.

**`packages/contracts/src/__tests__/dashboard-filter-observer.test.ts`** (§10.3)

- Toggling a filter chip calls `render` exactly once on every registered view, in registration order.

**`packages/contracts/src/__tests__/dashboard-function-card-singleton.test.ts`** (§10.2)

- Opening a card while another is open closes the first; at most one `.function-card-overlay` exists in the DOM at any moment.

#### From §11 (Phase 4 — DRY extractions)

**`packages/contracts/src/__tests__/dashboard-function-row.test.ts`** (§11.2)

- `renderFunctionRows` against three column configurations (Hot / Big / Wide). Asserts header text and cell values.

**`packages/contracts/src/__tests__/dashboard-path-utils.test.ts`** (§11.2)

- `packageOfPath('packages/contracts/src/index.ts') === 'contracts'`.
- `packageOfPath('packages/fitness/engine/src/cli/dashboard.ts') === 'fitness'`.
- `packageOfPath('not-a-package/foo.ts') === '<unknown>'`.
- Empty string / invalid input → `'<unknown>'`.

#### Workspace-test integrity

**Existing dashboard tests stay green.** No file under `packages/contracts/src/__tests__/` other than those listed above is modified by v0.3. The single exception: `dashboard.test.ts`'s test for the existing thin code-paths panel (the "no graph sessions yet" message) is **deleted** — the v0.3 panel doesn't render that string. Its replacement is `dashboard-generator-graph-catalog.test.ts`'s null-catalog assertion above.

**Acceptance.**

- `pnpm --filter=@opensip-tools/contracts test` passes for every file above.
- `pnpm --filter=@opensip-tools/checks-typescript test` passes for the new fitness-check tests.
- `pnpm test` (workspace-wide) passes.
- No `.skip(...)`, no `.todo(...)`, no test that asserts a placeholder string.
- jsdom is available as a workspace dev dep (verified by Phase P0 if not already).

### Phase V — Validation (full end-to-end flow)

**Goal.** Exercise the full integrated flow against the dogfood target (opensip-tools itself). This is the one phase that hits the live catalog, not synthetic fixtures.

**The validation script.** Runs as a vitest integration test under `packages/contracts/src/__tests__/dashboard-validation.integration.test.ts`. Tagged with `@integration` so it's skipped on plain `pnpm test --filter` runs but executes on CI.

**End-to-end flow.**

1. **Build the package.** `pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/contracts build && pnpm --filter=@opensip-tools/cli build`.
2. **Run the graph CLI against opensip-tools itself.** Shell-out to `node packages/cli/dist/index.js graph` from the repo root. Asserts exit code 0; asserts `<repo>/opensip-tools/.runtime/cache/graph/catalog.json` exists.
3. **Run the dashboard CLI.** Shell-out to `node packages/cli/dist/index.js dashboard`. Asserts exit code 0; asserts `<repo>/opensip-tools/.runtime/reports/latest.html` exists.
4. **Load the HTML in jsdom.** Parse with jsdom; evaluate the inlined `<script>`.
5. **Assert panel-init succeeded.** No JS errors thrown during evaluation. The `views` array has length 7.
6. **Tab-click each view.** For each `view.id` in `['hot', 'big', 'wide', 'coupling', 'untested', 'sccs', 'search']`:
   - Programmatically dispatch a click on the corresponding tab.
   - Assert no thrown errors.
   - Assert the active container has at least one `[data-body-hash]` element OR the documented empty-state element. (SCC view may legitimately be empty for opensip-tools.)
7. **Open a Function Card.** For the first row of the `hot` view, dispatch a click. Assert:
   - One `.function-card-overlay` element exists in the DOM.
   - Its text contains the function's `simpleName`.
   - Its callers list has length === `indexes.callers[bodyHash].length`.
8. **Recurse into a caller.** Click the first caller row in the open card. Assert:
   - Still exactly one `.function-card-overlay` element.
   - Its content has changed (different `simpleName` shown).
9. **Close the card.** Press Escape (synthesize a keyboard event). Assert no `.function-card-overlay` element remains.
10. **Filter a view.** Tab back to `hot`. Toggle off a package chip. Assert the visible row count decreased.
11. **Search.** Type `"logger"` into the search input. Assert the search tab is now active and at least one row contains `logger`.
12. **Editor deep-link.** With `dashboard.editor: vscode` in the test config, click the "open in editor" button on the open card. Assert a clickable `<a>` was rendered with `href="vscode://..."` (the test does not actually launch an editor).
13. **Trace from entry.** Click the "trace from entry" button. Assert the card body changes to the path display.

**Negative validation (catalog absent).**

14. Delete `<repo>/opensip-tools/.runtime/cache/graph/catalog.json`. Re-run dashboard.
15. Assert the rendered HTML loads cleanly.
16. Assert the Code Paths panel shows the documented empty state ("No graph sessions yet. Run `opensip-tools graph` to generate one.").

**Portability validation.**

17. Copy `<repo>/opensip-tools/.runtime/reports/latest.html` to a temp dir on the test runner.
18. Open the file via `file://` URL in jsdom.
19. Assert all 7 views still render correctly. (No external fetch, no missing asset.)

**Acceptance.**

- The integration test passes locally and in CI.
- Total runtime ≤ 60 seconds (catalog generation dominates).

### Phase D — Documentation (full doc-update list)

**Goal.** Synchronize opensip-tools project documentation with the as-built v0.3. This phase runs **last** so docs reflect what shipped, not what was designed.

**Doc updates — concrete file list.**

1. **`docs/architecture/60-surfaces/03-dashboard.md`** (existing).
   - Add a new "Code Paths panel" subsection under "What it shows" (alongside Overview, Sessions, Checks catalog, Recipes).
   - Describe the seven views (Hot, Big, Wide, Coupling, Untested, SCCs, Search) with one paragraph each — the same shape the doc uses for Overview/Sessions/etc.
   - Describe the universal Function Card pattern.
   - Describe the inline-catalog data transport (`<script type="application/json" id="graph-catalog">`) under "How it's generated."
   - Cross-link to this design doc and to the v0.2 design doc.
   - Add `last_verified` bump.

2. **`docs/architecture/70-reference/01-package-catalog.md`** (existing).
   - Update `@opensip-tools/contracts`'s "Key exports" to add `GraphCatalog` type (the new public type export).
   - No other package row changes — v0.3 doesn't add or move any package.

3. **`docs/plans/graph-tool-v2-design.md`** (existing, status: implemented).
   - Locate its "What's deferred to v0.3+" section and add a forward-pointer to `./graph-dashboard-v3-design.md` confirming the deferred dashboard surface has been designed and is being implemented.
   - No structural changes to the v0.2 doc — it's frozen as the historical record of the v0.2 ship.

4. **This document (`graph-dashboard-v3-design.md`)** — flip `status: draft` → `status: implemented` once Phase V passes; bump `last_verified`.

**ADR captures.** The seven load-bearing decisions of v0.3 are recorded in Appendix C below, mirroring v0.2's in-document ADR convention.

**Post-implementation coder checklist.** See §13.

**Acceptance.**

- Each doc above is updated.
- A doc-coverage check (`grep -L 'graph-dashboard-v3' docs/architecture/60-surfaces/03-dashboard.md`) returns nothing — proving the cross-link is in place.
- `docs/architecture/70-reference/01-package-catalog.md` lists `GraphCatalog` in the contracts row.

---

## 8. Acceptance gates

For v0.3 to ship:

1. **All existing dashboard tests pass.** v0.3 doesn't break the v0.2 dashboard layout for fitness/sim panels.
2. **All workspace tests pass.** This is a contracts-package change plus a small fitness CLI plumbing change; nothing else affected.
3. **Function Card renders correctly** for at least 5 functions covering different shapes (function, method, arrow, getter, constructor) — exercised in Phase T tests.
4. **All 7 views render without errors** when given a representative catalog (use opensip-tools catalog as the test input) — exercised in Phase V validation.
5. **The dashboard remains portable** — copy the report directory to a different machine and the panel works without any server.
6. **No new heavy dependency in `@opensip-tools/contracts`.** No React, no Vue, no D3 (heatmap is text-shaded HTML, not SVG). `package.json` `dependencies` delta = 0; `devDependencies` may gain `jsdom` if it's not already present in the workspace.
7. **Architectural invariants AI-1..AI-8 and MI-1..MI-5 (§2.5/§2.6) hold.** Each is enforced by a dep-cruiser rule, a fitness check, or a code-review checkpoint listed in §9. CI fails on violation.
8. **`pnpm lint` passes** including the new dep-cruiser rules listed in §9.

---

## 9. Dep-cruiser additions, fitness-check additions, and dependency-policy

These are wired into `.dependency-cruiser.cjs` and the fitness check registry in Phase P0. CI fails the build if any rule fires.

### 9.1 New dep-cruiser rules

```js
{
  name: 'dashboard-no-graph-import',
  severity: 'error',
  comment: 'AI-3: dashboard code-paths must not import @opensip-tools/graph; ' +
           'consume the catalog by JSON shape only.',
  from: { path: '^packages/contracts/src/persistence/dashboard/code-paths' },
  to:   { path: '^@opensip-tools/graph(/|$)' },
},
{
  name: 'dashboard-code-paths-self-contained',
  severity: 'error',
  comment: 'MI-1: code-paths/* may import only from contracts itself, dashboard siblings, ' +
           'and Node built-ins. No cross-package imports.',
  from: { path: '^packages/contracts/src/persistence/dashboard/code-paths/' },
  to:   {
    path: '^@opensip-tools/(?!contracts(/|$))',
    pathNot: '^node:',
  },
},
{
  name: 'dashboard-views-disjoint',
  severity: 'error',
  comment: 'MI-2: code-paths/view-*.ts files must not import each other. ' +
           'They share state through views-registry, filterState, and indexes only.',
  from: { path: '^packages/contracts/src/persistence/dashboard/code-paths/view-' },
  to:   { path: '^packages/contracts/src/persistence/dashboard/code-paths/view-' },
},
{
  name: 'dashboard-algorithms-no-view-deps',
  severity: 'error',
  comment: 'MI-3: pure-algorithm modules (scc, search, trace) must not import view files or function-card.',
  from: { path: '^packages/contracts/src/persistence/dashboard/code-paths/(scc|search|trace)\\.ts$' },
  to:   { path: '^packages/contracts/src/persistence/dashboard/code-paths/(view-|function-card\\.ts)' },
},
{
  name: 'dashboard-no-side-stylesheets',
  severity: 'error',
  comment: 'AI-4: new CSS must extend dashboard/css.ts. No external .css imports inside contracts.',
  from: { path: '^packages/contracts/src/' },
  to:   { path: '\\.css$' },
},
{
  name: 'dashboard-no-ui-framework',
  severity: 'error',
  comment: 'AI-2: contracts must not depend on any UI framework or visualization library.',
  from: { path: '^packages/contracts/src/' },
  to:   {
    path: '^(react|preact|vue|svelte|@?solidjs|d3|d3-.+|three|cytoscape|sigma|vis-network|@?angular)(/|$)',
  },
},
```

The `dashboard-no-graph-import` rule is the load-bearing one: it codifies the §2.4 decoupling claim that "code-paths.ts does not import from `@opensip-tools/graph`."

### 9.2 New fitness checks

Two new checks land in `@opensip-tools/checks-typescript` to enforce the structural invariants dep-cruiser cannot express:

| Slug | Pack | Enforces | Implementation sketch |
|---|---|---|---|
| `dashboard-no-ui-framework-deps` | `checks-typescript` | AI-2 | Inspect `packages/contracts/package.json` `dependencies`. Fail if any of `react|vue|svelte|d3|...` (the same denylist as the dep-cruiser rule) is present. |
| `dashboard-view-single-export` | `checks-typescript` | MI-5 | For every `packages/contracts/src/persistence/dashboard/code-paths/view-*.ts`, parse via the TS AST and assert exactly one named export matching `dashboardView[A-Z][A-Za-z]*Js`. |

These checks live alongside the existing v0.2 `graph-stage-language-isolation` check in `@opensip-tools/checks-typescript`; they're added to the `architecture` recipe so they run on every CI pass.

### 9.3 Dependency policy

- **`packages/contracts/package.json`** — `dependencies` delta MUST be **zero**. (Verified by AI-2 and the new fitness check.)
- **`devDependencies`** — `jsdom` may be added if not already present in the workspace devDeps (it is required for Phase T tests). No other new dev deps.
- **No subpath exports added.** The existing `@opensip-tools/contracts` barrel already exports `generateDashboardHtml`. v0.3 extends it with one new type export (`GraphCatalog`) — that's the entire public-API delta.

### 9.4 Tests phase coverage of architectural assertions

Phase T (Tests) is updated by Phase 2 of the pipeline review to include:

- **`dashboard-arch.test.ts`** — synthetic-violation tests that:
  - Assert `dashboard-no-graph-import` fires when a fixture file under `code-paths/` imports `@opensip-tools/graph`.
  - Assert `dashboard-views-disjoint` fires when a fixture `view-x.ts` imports `view-y.ts`.
  - Assert `dashboard-no-ui-framework` fires when a fixture imports `react`.
- **`dashboard-fitness-checks.test.ts`** — exercises the two new fitness checks against synthetic projects (one passing, one failing each).

These join the per-view tests scaffolded in §7 Phase T.

---

## 10. SOLID & GoF audit

Patterns are tools to manage existing complexity. Each decision below is paired with a concrete justification — a named test seam, a named compile-time invariant, or ≥3 implementations of the same shape. Speculative abstractions are explicitly rejected.

### 10.1 The seven views — polymorphic over `View`

**Question.** Are `view-hot.ts`, `view-big.ts`, `view-wide.ts`, `view-coupling.ts`, `view-untested.ts`, `view-sccs.ts`, `view-search.ts` truly polymorphic, or are they parallel-named files masquerading as a pattern?

**Verdict.** Polymorphic. They share **two** load-bearing seams:

1. The orchestrator's `for (const view of views) { /* dispatch */ }` loop in `code-paths.ts`.
2. The filter-state observer: `notifyViews()` calls `views[i].render(...)` whenever `filterState` changes.

Both are the v0.2 `Renderer`-pattern equivalent (one shape, ≥3 implementations consumed by a single dispatch site). The pattern is justified.

**Decision.** Define a `View` type alias in `code-paths/types.ts`:

```ts
interface View {
  readonly id: 'hot' | 'big' | 'wide' | 'coupling' | 'untested' | 'sccs' | 'search';
  readonly label: string;          // human-readable tab label
  /** Render the view into `container`. Idempotent — called on init AND on every filter change. */
  render(
    container: HTMLElement,
    catalog: GraphCatalog,
    indexes: Indexes,
    filterState: FilterState,
  ): void;
}
```

Every `view-*.ts` file's emitted JS pushes one `View` literal into `views`. The orchestrator does `views.find(v => v.id === activeId).render(...)`. **No `if (id === 'hot') {...} else if (id === 'big')` chains anywhere.**

This is **Strategy** (GoF) used because the orchestrator has 7 strategies and one dispatch site. Replacing it with a switch would require modifying the orchestrator every time a view is added — an OCP violation.

### 10.2 The Function Card — single component, no inheritance

**Question.** Is the Function Card "the universal drill-down" actually one component, or 7 sibling versions?

**Verdict.** One. The card has a fixed shape; it's parameterized by the `bodyHash` it's opening. Every view passes the same `bodyHash` to the same `openFunctionCard(bodyHash)` function.

**Decision.** `code-paths/function-card.ts` exports `dashboardFunctionCardJs(): string`. The emitted JS exposes exactly two public functions: `openFunctionCard(bodyHash)` and `closeFunctionCard()`. No subclassing, no per-view variants.

The card has internal sub-renderers — caller list, callee list, action buttons — but they're private functions, not separate exported strategies. **No premature `CardSection` interface; if a 4th sub-section ever shows up, revisit.**

This is the **anti-pattern fix** for the question "is the universal card actually 7 cards in disguise?" — the answer is no, and the design enforces that by exposing only the two public functions above.

### 10.3 The filter system — Observer (Subject + Observers)

**Question.** Are filters shared, or duplicated per view?

**Verdict.** Shared. Three filter dimensions × seven views = 21 places where filtering happens. Duplicating is the wrong move.

**Decision.** **Observer** (GoF). `code-paths/filters.ts` owns a singleton `filterState` (the Subject). Views are Observers — they subscribe by being in the `views` registry. `notifyViews()` is the notify call.

The justification is the named compile-time invariant: every view conforms to `View.render(container, catalog, indexes, filterState)`, which means every view, by construction, receives the latest filter state on every notification. There's no opt-in/opt-out — subscription is automatic via registry membership.

This is **not** an event-bus. There's one Subject, one event ("filter changed"), no payload beyond `filterState`. We don't introduce a generic pub/sub layer.

### 10.4 The Tabs system — reuse, not abstract

**Question.** Should the v0.3 panel reuse the existing `tool-tabs.ts` infrastructure, or define its own tab system?

**Verdict.** Reuse the **pattern** (the existing tab handler shape in `shared.ts`); define seven view-specific containers as siblings. Do **not** invoke `renderToolTab()` — that helper is hard-wired to the fitness/sim 3-subtab model and is not parameterizable enough.

**Decision.** `code-paths.ts` mirrors `shared.ts`'s tab-bar event handler with a local listener bound to the `.code-paths-tabs` element. The implementation is ~10 LOC of vanilla DOM; abstracting it would be premature.

This is the rule of three failing: only **two** uses of a tab bar exist (top-level + code-paths). Third use → revisit and extract.

### 10.5 Where SOLID violations could creep in (vigilance list)

These are anti-patterns the v0.3 implementation must **not** introduce. Code review will reject any of them.

| Anti-pattern | Where it could appear | Why reject |
|---|---|---|
| One-strategy Strategy | A `Renderer` interface in `view-coupling.ts` for "the matrix renderer" with one impl | Premature; no second implementation in v0.3 scope. |
| Abstract base class for views | `class BaseView { abstract render(); }` | TypeScript's structural typing covers it via the `View` interface; an abstract class would be a class-without-state. |
| Visitor pattern over the catalog | `catalog.accept(visitor)` | The catalog's shape is closed (one type); a regular function is shorter. |
| Singleton `Indexes` accessor | `Indexes.getInstance()` | `indexes` is a parameter on every `View.render(...)`; singletons hide test seams. |
| Template Method on the function card | `class FunctionCard { renderHeader(); abstract renderBody(); }` | The card's shape is fixed across all callers; no body-shape variation exists. |
| Factory for `View` objects | `class ViewFactory { createView(id) {...} }` | View modules push their own literal into the registry; factories add indirection without leverage. |

### 10.6 Tests phase additions for new pattern seams

Phase T is updated by Phase 3 of the pipeline review to include:

- **`view-conformance.test.ts`** — for each registered `View`, assert its shape matches the `View` type at runtime: `id` is one of the seven valid ids, `label` is a non-empty string, `render` is a function. This is the compile-time invariant from §10.1, asserted at runtime so a regression in the JS-string emitter trips a test.
- **`filter-observer.test.ts`** — toggle a filter chip; assert every view's `render` is called once, in registration order. Validates the Observer (§10.3).
- **`function-card-singleton.test.ts`** — open a card, then open a second card without closing the first; assert only one `.function-card-overlay` exists in the DOM. Validates §10.2 ("single component, not 7 in disguise").

These join the per-view tests scaffolded in §7 Phase T and the architectural tests added by §9.4.

---

## 11. DRY — package reuse and code-level deduplication

DRY at two levels: **package-level reuse** (does an existing opensip-tools primitive already provide this?) and **code-level deduplication within v0.3** (is the same concept expressed twice within the new code?).

The audit below was performed against the existing `packages/contracts/src/persistence/dashboard/` source. Every opportunity for reuse is named; every code-level extraction is justified by ≥3 callers (rule of three) unless an explicit exception is documented.

### 11.1 Package reuse audit

| Existing primitive | Source | v0.3 use |
|---|---|---|
| `el(tag, attrs, children)` DOM builder | `shared.ts` (already in scope of every panel's inlined script) | **Reuse universally.** Every view's render path uses `el()` instead of `innerHTML` or hand-written `document.createElement`. The Function Card, the filter chips, the search results — all use `el()`. No new DOM helper. |
| `paginateTable(tbody, container, pageSize)` and `renderPageButtons(...)` | `shared.ts` | **Reuse for Hot/Big/Wide/Untested views.** Each has a sortable, paginatable table; the existing helpers handle 50–100-row tables with the right pagination affordances. v0.3 does not invent its own pagination. |
| `makeSortable(table)` and `.data-table.sortable` class | `shared.ts` (auto-applied to every `.data-table.sortable` after render) | **Reuse universally.** Every v0.3 table uses `class="data-table sortable"` and inherits sort behavior. The view's `render(...)` only emits the `<table>`; sort wiring is automatic. |
| CSS classes `.card`, `.badge`, `.muted`, `.metrics`, `.findings`, `.stat-grid`, `.stat-card`, `.data-table`, `.pagination-btn`, `.empty` | `css.ts` | **Reuse universally.** The Function Card uses `.card`. Filter chips use a new `.code-paths-chip` (added in P0); but inactive chips are rendered with `.muted`. The empty-state placeholder uses `.empty`. View tables use `.data-table.sortable`. **No CSS duplication.** |
| Tab-bar handler in `shared.ts` | `shared.ts` (delegated click on `#tab-bar`) | **Pattern reuse, not direct invocation.** The existing handler is bound to `#tab-bar` (top-level tabs). v0.3 binds an analogous local handler to `.code-paths-tabs` (~10 LOC); see §10.4. |
| `renderToolTab(...)` in `tool-tabs.ts` | hard-wired to `Overview / Catalog / Recipes` | **Do NOT reuse.** Hard-wired to the fitness/sim shape; making it parameterizable to 7 view tabs would balloon its API. Mirror the **pattern** instead (§10.4). |
| `escapeForScriptContext(json)` | `generator.ts` | **Reuse for the new `id="graph-catalog"` block.** Keeps escape-sanitization centralized. |
| Inline-JSON-blob data transport | `generator.ts` (`<script type="application/json">`) | **Reuse exactly.** §2.4 + §2.5 (AI-7) codify this. |
| Vitest + jsdom test setup | `packages/contracts/vitest.config.ts` and existing `packages/contracts/src/__tests__/dashboard.test.ts` (which already evaluates the generated HTML) | **Reuse.** Phase T's tests are colocated under the same `__tests__/` directory and use the same vitest config. No new harness. |
| Session-loading shape (`sessions = JSON.parse(blob)` at panel init) | `generator.ts` lines 70–74 | **Mirror the pattern** for the catalog: `const graphCatalog = JSON.parse(document.getElementById('graph-catalog')?.textContent ?? 'null');`. Same idiom, same place in the inlined script. |

### 11.2 Code-level deduplication within v0.3 (rule of three)

The rule: extract once a third caller exists. Two callers stay duplicated until the third arrives.

| Concern | Callers in v0.3 | Decision |
|---|---|---|
| **Resolving a function from a `bodyHash`** | Function Card opens it (1), every view's row click resolves it (7), trace-from-entry resolves intermediate hashes (1+). Total ≥ 9. | **Extract.** `code-paths/indexes.ts` already exposes `byBodyHash` — every caller does `indexes.byBodyHash.get(bodyHash)`. No new helper needed; the index map *is* the helper. |
| **Building a `<table>` of function rows** | Hot, Big, Wide, Untested all render this shape (4 callers). | **Extract.** `code-paths/function-row.ts` exports `dashboardFunctionRowJs(): string`. The emitted JS exposes `renderFunctionRows(container, occurrences, columns)` — `columns` is a tiny array of `{ label, value(occ) }`. Each view passes its column set. **Pull-out justified by 4 callers.** |
| **Filter-chip rendering** | One caller — `code-paths/filters.ts` itself. Views *consume* `filterState` but don't render chips. | **Do not extract** further. Already centralized by design. |
| **Tarjan's SCC algorithm** | One caller (`view-sccs.ts`). | **Keep in `code-paths/scc.ts` as its own file** (separation by concern, not by reuse). Splitting algorithm from view is the §10.5 anti-Singleton/anti-Visitor reasoning — pure functions in their own module are testable in isolation. |
| **Fuzzy search** | One caller (`view-search.ts`) plus the persistent search input handler. Two call paths, but they share the same view module. | **Keep in `code-paths/search.ts`.** Same reasoning: pure-algorithm separation, not reuse-driven extraction. |
| **Editor deep-link URL generation** | One caller (Function Card "open in editor" button). | **Keep in `code-paths/editor-link.ts`.** Single caller, but it's the natural separation seam — the URL-builder is independently testable without the card DOM. |
| **Package-from-filepath derivation** | View 4 (coupling matrix) extracts package from caller and callee. View 5 (untested) checks if any caller is in `inTestFile`. View 6 (SCCs) labels packages on the cluster row. View 7 search results show the package label. ≥ 4 callers. | **Extract.** Add `packageOfPath(filePath: string) → string` to `code-paths/types.ts` (or `code-paths/path-utils.ts` if it grows). One regex (`^packages/([^/]+)/`); one fallback for non-packages files. **Pull-out justified by 4 callers.** |
| **Browser-side `Indexes` build** | Every view consumes them; the panel orchestrator builds them once at init. | **Single-source-of-truth seam.** `code-paths/indexes.ts::buildIndexes(catalog)` is called once; cached in a panel-init closure. **Compile-time invariant:** every `View.render(...)` receives the same `indexes` reference, so divergence is impossible by construction. |
| **JSON-decoding the embedded blob** | One place (panel-init in `code-paths.ts`). | **One caller.** Don't extract. |

**Three extractions confirmed by Phase 4 of the pipeline review:**

1. `code-paths/function-row.ts::renderFunctionRows(container, occurrences, columns)` — 4 callers (Hot, Big, Wide, Untested).
2. `code-paths/path-utils.ts::packageOfPath(filePath)` — 4 callers (View 4, View 5, View 6, View 7).
3. *(none more)* — every other candidate has < 3 callers and stays inline.

The ≥3-callers rule keeps the v0.3 surface lean: ~16 files, no speculative shared utilities.

### 11.3 Things explicitly NOT to deduplicate

The following look like duplication but aren't, and the implementation must not be tempted:

- **Per-view filter logic.** Each view's filter behavior is the same shape (`filterState` × `occurrence` → boolean) but computed differently:
  - Hot filters by package of the *callee*'s file path.
  - Untested filters by `inTestFile === false` AND `inTestFile === false` for all callers.
  - SCCs filter the cluster, not individual rows.
  Forcing them through a single `filterFn(occ, state)` would erase the per-view semantics. Each view holds its own filter predicate inline. **Not duplication; specialization.**
- **Per-view rendering layout.** Hot is a wide table with caller counts; Big shows body-length bars; Wide shows param thumbnails; Coupling is a matrix; SCCs is a cluster list. Different shapes, deliberately. The `renderFunctionRows(...)` helper handles only the simple-table shape (4 of 7 views).
- **Test fixtures.** Each test file builds its own synthetic catalog. Sharing fixtures across tests would couple them; tests stay isolated.

### 11.4 Tests phase additions for the new shared code

Phase T is updated by Phase 4 of the pipeline review to include:

- **`function-row.test.ts`** — `renderFunctionRows(...)` against synthetic occurrences and three different `columns` configurations (Hot's, Big's, Wide's). Asserts the table cell values match.
- **`path-utils.test.ts`** — `packageOfPath('packages/contracts/src/index.ts') === 'contracts'`; `packageOfPath('not-a-package/foo.ts') === '<unknown>'`.

These join the per-view, architectural, and pattern-seam tests already added by Phases 1–3 of the pipeline review.

### 11.5 Module layout updates

§6's module layout is updated to add the two extractions:

```
code-paths/
  ...
  function-row.ts                # renderFunctionRows(container, occurrences, columns) — 4 callers
  path-utils.ts                  # packageOfPath(filePath) — 4 callers
  ...
```

Total file count: ~18 (was ~16 in §6 before this phase). Per-file LOC budget unchanged (≤200 LOC each).

---

## 12. Post-implementation coder checklist

A linear checklist for the coder agent that builds v0.3. Every item is also covered by an acceptance gate elsewhere in the doc; this list exists for the agent to scan in one read.

**Phase P0 (skeleton + wiring).**

- [ ] `packages/contracts/src/persistence/dashboard/code-paths.ts` — old 64-LOC content deleted; new skeleton emits the panel scaffold.
- [ ] `packages/contracts/src/persistence/dashboard/code-paths/` directory exists with placeholder files for every entry in §6 module layout.
- [ ] `generator.ts` accepts a fourth optional parameter `graphCatalog: GraphCatalog | null` and emits the `id="graph-catalog"` block when non-null.
- [ ] `packages/fitness/engine/src/cli/dashboard.ts` reads `<paths.graphCatalogPath>` if it exists and passes it to `generateDashboardHtml`.
- [ ] `packages/contracts/src/index.ts` re-exports `GraphCatalog` type.
- [ ] `dashboard/css.ts` extended with `.code-paths-view`, `.code-paths-tabs`, `.code-paths-search`, `.code-paths-filter-chips`, `.function-card-overlay`.
- [ ] `.dependency-cruiser.cjs` — six new rules from §9.1 added.
- [ ] `@opensip-tools/checks-typescript` — two new fitness checks from §9.2 added and registered.
- [ ] `pnpm typecheck && pnpm test && pnpm lint` is 0-error.

**Phases P1–P9 (per-phase wiring).** Each phase's "Steps" list ends with an explicit "Wire into …" step. Verify every phase's render path is reachable from the panel before moving to the next.

**Phase T (tests).** Every test file enumerated in §7 Phase T exists and passes. No `.skip`, no `.todo`.

**Phase V (validation).** The 19-step integration script in §7 Phase V passes against opensip-tools itself.

**Phase D (docs).** The four doc updates from §7 Phase D land. `status: draft` flipped to `status: implemented` on this doc; `last_verified` bumped to the ship date.

**Final.**

- [ ] All 8 acceptance gates in §8 pass.
- [ ] All architectural invariants AI-1..AI-8 and MI-1..MI-5 hold (§2.5/§2.6).
- [ ] All seven ADRs in Appendix C are in effect (the design matches the recorded decisions).
- [ ] Dashboard portability verified (copy `latest.html` to a temp dir; opens cleanly).
- [ ] No new direct dependency in `@opensip-tools/contracts` `package.json`.

---

## 13. Status

Draft, ready for the 6-phase improvement pipeline. Branch: `feat/graph-dashboard` (off main, contains the merged v0.2). Implementation begins after pipeline review.

---

## Appendix A — Why these 7 views and not others

A few that were considered and dropped per the filter:

- **"Function size histogram"** — passive stat. Doesn't pass the filter. Information without action.
- **"Per-package function count"** — same. Stat, not insight.
- **"Calls-per-line ratio"** — interesting metric, but no action attached. Drop.
- **"Functions defined but never imported"** — partially covered by orphan-subtree rule already in v0.2. Don't duplicate the surface.
- **"Functions with the most decorators"** — niche. Wait for a real user request.
- **"Trace path between two specified functions"** — useful, but requires the user to know two functions to query. The "Trace from entry point" button on the Function Card serves the same purpose for the common case.
- **"Refactoring suggestions"** — the rules layer's job, not the dashboard's. The dashboard exposes data; rules enforce policy.

The seven views ship because each passes the "why look, what do" filter sharply. Anything else needs to clear the same bar.

---

## Appendix B — Gaps deferred to downstream pipeline phases

Per the Phase 1 directive, the following concerns are noted as gaps here and resolved by the dedicated downstream phases:

- ~~**Architectural-compliance specifics**~~ — Phase 2 of the pipeline review **(resolved):** §2.5 (AI-1..AI-8), §2.6 (MI-1..MI-5), and §9 (dep-cruiser rules + fitness checks + dependency policy).
- ~~**SOLID / GoF audit**~~ — Phase 3 of the pipeline review **(resolved):** §10 (10.1 polymorphic `View`, 10.2 single-component card, 10.3 filter Observer, 10.4 tab-system reuse, 10.5 vigilance list, 10.6 pattern-seam tests).
- ~~**DRY audit**~~ — Phase 4 of the pipeline review **(resolved):** §11.1 (package-reuse audit), §11.2 (code-level extractions: `function-row.ts`, `path-utils.ts`), §11.3 (NOT-to-extract list), §11.4 (DRY tests), §11.5 (module-layout deltas).
- ~~**Tests/validation coherence sweep**~~ — Phase 5 of the pipeline review **(resolved):** Phase T's full test inventory grouped by source phase (P0–P9, §9, §10, §11) and Phase V's 19-step end-to-end validation flow.
- ~~**Architecture docs and ADRs**~~ — Phase 6 of the pipeline review **(resolved):** Phase D's four-doc update list, Appendix C's seven ADRs, §12's coder checklist.

---

## Appendix C — Architectural Decision Records

Mirroring the v0.2 design's in-document ADR convention. Each decision is load-bearing for v0.3; reversing one requires a follow-up design doc.

### ADR-V3-1 — Inline JSON catalog embedding (chosen) vs out-of-band fetch

**Status.** Accepted.

**Context.** The catalog is a multi-megabyte JSON blob (~12 MB on opensip-tools, larger on real monoliths). The dashboard needs the data to render any view.

**Options.**

- **A. Inline.** Embed the catalog as `<script type="application/json" id="graph-catalog">…</script>`. Same idiom as the existing sessions-data and check-catalog blobs.
- B. Out-of-band fetch. Write the catalog as a sibling JSON file; the panel `fetch()`s it on init.

**Decision.** A.

**Rationale.**

- Preserves the dashboard's portability invariant — a single HTML file you can email or commit. Option B requires *two* files and a `file://` fetch (which several browsers refuse for security reasons).
- The existing dashboard already inlines multi-MB sessions data. The catalog is a quantitative increase, not a qualitative one.
- Option B reintroduces the very thing v0.3 deliberately avoids (§5: "no server, no backend").

**Trade-offs.** Page weight grows proportionally to catalog size. v0.4 may revisit if catalogs exceed ~50 MB; for v0.3 the inline approach holds.

### ADR-V3-2 — Tab system: pattern-reuse, not invocation-reuse

**Status.** Accepted.

**Context.** The existing dashboard has two tab abstractions: the top-level `#tab-bar` handler in `shared.ts`, and the subtab system in `tool-tabs.ts::renderToolTab(...)`.

**Options.**

- A. Reuse `renderToolTab(...)` directly. Pass it the seven view ids as a labels array.
- **B. Mirror the pattern.** Bind a delegated click handler to `.code-paths-tabs` modeled on `shared.ts`'s `#tab-bar` handler. ~10 LOC.
- C. Invent a new abstract `TabSystem` class.

**Decision.** B.

**Rationale.** `renderToolTab(...)` is hard-wired to `Overview / Catalog / Recipes` (the fitness/sim 3-subtab shape). Generalizing it to seven dynamic tabs would balloon its API; the pattern is simpler than the abstraction. C fails the rule of three (only two uses exist).

### ADR-V3-3 — Vanilla DOM, no framework

**Status.** Accepted.

**Context.** v0.3 introduces ~16 new files of UI code. A framework (React, Vue, Svelte) would speed up the per-view ergonomics.

**Options.**

- A. React (or any virtual-DOM framework).
- **B. Vanilla DOM with `el()` from `shared.ts`.**

**Decision.** B.

**Rationale.**

- AI-2 (§2.5): zero new direct deps in `@opensip-tools/contracts`. A framework violates this.
- The dashboard is a single HTML file. Inlining a framework runtime (~50 KB minified for React) for the kind of UI v0.3 actually needs is gross over-fetching.
- The existing dashboard uses vanilla DOM and produces clean, testable code. v0.3 follows the same pattern.
- Vanilla code is easier for an AI agent to generate correctly without a framework's hidden conventions.

### ADR-V3-4 — Coupling heat map: text-shaded HTML, not SVG

**Status.** Accepted.

**Context.** View 4 displays a package-by-package coupling matrix. The cells need a visual density indicator.

**Options.**

- A. SVG. Render the matrix as `<rect>`s with `fill` proportional to density.
- **B. Text-shaded HTML.** Each cell is a `<td>` with a CSS custom property `--density`; the cell color is `color-mix(...)` between `--bg` and `--accent`. Cell content is the raw count.

**Decision.** B.

**Rationale.**

- The matrix is small (≤ 17 × 17 for opensip-tools). HTML/CSS handles it fine.
- A `<td>` is naturally clickable; SVG `<rect>` requires extra event handling.
- B keeps the cell text accessible (screen readers, copy/paste, search).
- A would push toward a charting library, which violates ADR-V3-3 and AI-2.

### ADR-V3-5 — Search: substring-with-character-skip fuzzy match

**Status.** Accepted.

**Context.** View 7 (and the persistent search input) needs to match function names against a query.

**Options.**

- A. Strict prefix match. `"log"` matches `logger` but not `formatLog`.
- B. Regex match. The user types a regex.
- **C. Substring-with-character-skip fuzzy match.** The user's query characters must appear in order in the candidate, but not contiguously. `"lgr"` matches `logger`. Scoring rewards prefix + exact-case + contiguous runs.
- D. Levenshtein-distance ranking. More accurate but O(n × m) per candidate.

**Decision.** C.

**Rationale.**

- The use-case is "I half-remember the function's name." Prefix is too strict; regex is too cognitively expensive for casual lookup; Levenshtein is overkill for ≤ 50,000 candidates and slows the always-visible search input.
- Substring-with-skip is what users expect from VS Code's Cmd-T. Familiar UX.
- ~30 LOC of pure JS, no dep, no library. Fits in `code-paths/search.ts` ≤ 200 LOC.

### ADR-V3-6 — Function Card: modal overlay, not inline expansion

**Status.** Accepted.

**Context.** Clicking a function in any view opens the universal Function Card. This can render as a modal overlay (above the view) or inline (expanding the row).

**Options.**

- **A. Modal overlay.** Single `.function-card-overlay` element appended to `<body>`; closes on Escape, click-outside, or close button.
- B. Inline row expansion. The clicked row expands in place to show the card content.

**Decision.** A.

**Rationale.**

- A single overlay enforces §10.2's "one component, not 7 in disguise" — every view, every click, opens the same DOM node. Inline expansion would scatter near-identical card markup into every view's render output.
- Recursion is trivial with A: clicking a caller in the open card swaps the overlay's content. With B, recursion would mean expanding a row inside an expanded row — visually confusing.
- A separates "view" (the table behind) from "drilldown" (the card on top); the user's mental model stays intact.

**Trade-offs.** Modal overlays trap focus and can feel heavyweight for casual exploration. Mitigated by Escape-to-close and click-outside-to-close.

### ADR-V3-7 — The "why look, what do" filter is the v0.3 design principle

**Status.** Accepted.

**Context.** v0.3 must resist scope creep into a generic dashboard. Every view must justify itself.

**Decision.** Codify the §1 filter as the design principle. Every view, every interaction, every drill-down in v0.3 satisfies:

1. **Why would someone look at this?** A concrete, named scenario.
2. **What would they do next?** A concrete action.

If a proposed view fails either question, it doesn't ship in v0.3.

**Rationale.** The temptation in dashboard work is to "show useful information." Without a filter, this becomes "show all the information, the user will find what's useful." That's a stat dump, not exploration. The seven views in §3 each pass both questions explicitly; Appendix A enumerates seven that *don't* and were deliberately dropped.

This ADR is what makes Appendix A's "considered and rejected" list non-arbitrary: the rejection rationale is the same filter every time.

**Enforcement.** Code review. Every PR adding a view must answer the two questions in the PR description. PRs that can't are rejected.

---

## Pipeline coherence check

A final-pass audit performed after all six phases of the plan-improvement pipeline ran sequentially.

### 1. Each phase's "Output:" specification is satisfied

| Phase | Output expectation | Where in the plan |
|---|---|---|
| Phase 1 | Phases ordered by dependency; explicit steps; enforced wiring per phase; integration-surface coverage; scaffolded tests/validation phases. | §7 Phases P0–P9 (each with a "Wire into …" step); Phase T and Phase V (initially scaffolded, later enriched). **Satisfied.** |
| Phase 2 | Each architectural compliance issue named, located, and a corrective change specified inline. | §2.5 (AI-1..AI-8), §2.6 (MI-1..MI-5), §9 (six dep-cruiser rules + two fitness checks + dependency policy). **Satisfied.** |
| Phase 3 | Each pattern decision documented in-line. | §10.1 (`View` polymorphism), §10.2 (Function Card singleton), §10.3 (filter Observer), §10.4 (tab pattern-reuse), §10.5 (vigilance list), §10.6 (pattern-seam tests). **Satisfied.** |
| Phase 4 | Every package-reuse opportunity identified; every code-level extraction concretely specified; every extraction backed by ≥3 callers. | §11.1 (9 reuse opportunities), §11.2 (`function-row.ts` 4 callers, `path-utils.ts` 4 callers), §11.3 (explicit do-not-extract list), §11.4 (DRY tests), §11.5 (module-layout delta). **Satisfied.** |
| Phase 5 | Tests phase reorganized with each prior phase's contribution grouped; validation phase enumerating end-to-end flows. | Phase T's headed groups (`From §7 implementation phases (P0–P9)`, `From §9`, `From §10`, `From §11`) plus 18 named test files; Phase V's 19 numbered end-to-end steps. **Satisfied.** |
| Phase 6 | Documentation phase enumerating every architecture doc to update; every decision captured as an in-doc ADR; post-implementation coder checklist. | Phase D's 4-doc update list; Appendix C's 7 ADRs (V3-1 through V3-7); §12 coder checklist. **Satisfied.** |

### 2. Cross-references resolve

- Section numbering is monotonic 1–13, plus appendices A, B, C. No missing, no duplicate.
- Every `§X` and `§X.Y` reference in the plan resolves to an existing heading. Specifically:
  - `§2.4`, `§2.5`, `§2.6`, `§4.5`, `§5`, `§6`, `§7 Phase T`, `§7 Phase V`, `§7 Phase D`, `§8`, `§9`, `§9.1`, `§9.2`, `§9.4`, `§10`, `§10.1`, `§10.2`, `§10.3`, `§10.4`, `§10.5`, `§10.6`, `§11.1`, `§11.2`, `§11.3`, `§11.4`, `§11.5`, `§12`, `§13` — all targets exist.
- Module-name references (e.g. `code-paths/view-hot.ts`, `code-paths/function-row.ts`, `code-paths/path-utils.ts`) are consistent across §6 (module layout), §7 (per-phase steps), §11.5 (DRY layout deltas), §12 (coder checklist), and Phase T (test file names). The §6 module layout was updated in §11.5 to add `function-row.ts` and `path-utils.ts`; both appear in Phase T's tests.
- Test-file references in Phase T (e.g. `dashboard-view-conformance.test.ts`) are consistent with the SOLID-section references (§10.6) that originally introduced them. No test name appears with two spellings.
- Appendix B's "resolved" tickboxes match the actual section content. Each downstream phase has a "(resolved)" entry pointing to the sections that closed it.

### 3. No phase invalidated an earlier phase's work

- **Phase 2 vs Phase 1.** Phase 1 specified per-phase wiring; Phase 2 added dep-cruiser rules and fitness checks. Phase P0's "Steps" list was extended to wire those rules and checks (steps 7 and 8) without disturbing the original P0–P9 ordering.
- **Phase 3 vs Phase 1/2.** Phase 3 introduced the `View` interface (§10.1) and codified Observer for filters (§10.3). Phase P3 (Filter chips + view registry) and the per-view phases P4–P8 already match this shape — Phase 3 named the pattern that Phase 1 had already structured. No conflict.
- **Phase 4 vs Phase 1/2/3.** Phase 4 added two extracted modules (`function-row.ts`, `path-utils.ts`). Both are referenced in §6 (module layout, updated by §11.5) and in Phase T's test inventory. The per-view phases P4–P7 implicitly depend on `function-row.ts` (Hot, Big, Wide, Untested all use simple-table rendering); the dependency is resolvable in the linear phase ordering because P3 builds the view registry that hosts the consumers, then P4 ships first using `function-row.ts` directly. **Note:** the plan should be read as "P4 introduces `function-row.ts` and uses it." This is consistent with the rule-of-three justification — the third caller (Wide) and fourth (Untested) appear in P5 and P7. Phase 4 of the pipeline review records the foresight; the actual extraction can land in P4 of the implementation when the second caller arrives, without breaking subsequent phases.
- **Phase 5 vs Phase 1/2/3/4.** Phase 5 reorganized Phase T's content; the test list grew but no test was dropped. The content of Phase V was extended from 5 vague steps to 19 numbered steps with negative- and portability-validation. Earlier phases' acceptance gates remain in §8 unchanged.
- **Phase 6 vs Phase 1/2/3/4/5.** Phase 6 added Phase D's doc-update list, Appendix C's seven ADRs, and §12's coder checklist. The ADRs *describe* decisions made by earlier phases (e.g. ADR-V3-3 records the §2.5 AI-2 framework ban; ADR-V3-6 records §10.2's modal-overlay decision). No design choice changed.

### 4. Internal consistency

- **Module names** — `code-paths.ts` (top-level), `code-paths/view-hot.ts`, `code-paths/view-big.ts`, etc. — used the same way in §6, §7, §10, §11, §12, and Phase T.
- **Test file names** — every test referenced from §7 Phase T is also referenced (or referencable) from the section that introduced it. No test name has two spellings.
- **File paths** — `packages/contracts/src/persistence/dashboard/code-paths/...` is the canonical path. Used uniformly. No `src/dashboard/...` shorthand bleeds in.
- **Phase ids** — implementation phases use `P0..P9` (with `T`, `V`, `D` for tests/validation/docs). Pipeline-review phases use `Phase 1..6` (referenced in Appendix B). No collision.
- **Acceptance vocabulary** — "Acceptance gates" (§8, eight numbered gates) is the load-bearing checklist; per-phase "Acceptance" sections in §7 are the per-phase entry conditions to the next phase. Both flavors are used consistently.

### 5. Findings

The plan is internally consistent. No remediation required.

One forward-looking note recorded above (Phase 4 vs Phase 1/2/3): the rule-of-three justification for `function-row.ts` and `path-utils.ts` formally lands when the third caller appears (P5/P7). The implementation can introduce the file at P4 when the first user arrives without violating the rule, but Phase 4's audit records that the extraction is justified across the lifetime of the implementation phases, not at any single phase. This is a minor scheduling note, not a coherence defect.
