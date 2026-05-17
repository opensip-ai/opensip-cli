---
status: draft
last_verified: 2026-05-16
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

All v0.3 code lives in `packages/contracts/src/persistence/dashboard/code-paths.ts` and a few sibling files for sub-components. The graph engine package is unchanged.

The HTML generator at `packages/contracts/src/persistence/dashboard/generator.ts` already pulls in `code-paths.ts`'s output. v0.3 expands what that file produces.

### 2.3 The data flow

1. `opensip-tools graph` runs. Stages 1+2 produce a catalog. Rules produce signals. The session writer persists the session record (which includes findings).
2. `opensip-tools dashboard` (or `opensip-tools graph --open`) regenerates the static HTML.
3. The generator reads `catalog.json` and `session.json`. Both are embedded into the page as `<script type="application/json">` blocks.
4. The Code Paths panel JS reads those blobs at page load and renders interactive views.

The catalog is large (~12MB on opensip-tools, larger on real monoliths). The dashboard already serves multi-MB inline JSON; this is consistent. If catalog size becomes a usability problem, v0.4 can move to an out-of-band fetch — but for v0.3, inline is fine.

### 2.4 Decoupling

The same architectural rules from v0.2 apply:

- **`code-paths.ts` does not import from the graph engine.** It consumes the catalog by JSON shape only.
- **The HTML/JS in `code-paths.ts` is plain — no React, no Vue, no framework dependency.** The existing dashboard uses vanilla DOM manipulation. v0.3 does the same.
- **`code-paths.ts` may import shared dashboard helpers** (CSS classes, the `el()` DOM builder if one exists). It does not invent new framework primitives.
- **Per-view JS lives in sub-files** when the view's logic exceeds ~100 LOC. Examples: `code-paths-hot.ts`, `code-paths-coupling.ts`. Imported by `code-paths.ts`.

---

## 3. The seven views

Each view answers a real developer question. Each has a clear "click → drill down" path. None is a static stat dump.

### View 1 — "Hot functions"

**Why someone looks:** "I'm about to change `logger`. Who else depends on it?" Or: "I'm onboarding to this codebase. What's the load-bearing infrastructure?"

**What they do:** Click a hot function → see its callers (file:line, ranked by package) → click into a caller → repeat. Recursive exploration of the dependency root.

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

**On click:**

```
┌─ logger (147 callers) ──────────────────────────────┐
│  Defined: packages/core/src/lib/logger.ts:12         │
│  Body: 17 lines, returns Logger                      │
│                                                      │
│  Called from:                                        │
│  ▸ packages/cli/* (38 calls)                         │
│  ▸ packages/fitness/* (41 calls)                     │
│  ▸ packages/graph/* (24 calls)                       │
│  ▸ packages/lang-*/* (44 calls)                      │
│                                                      │
│  [open file] [show full caller list]                 │
└──────────────────────────────────────────────────────┘
```

**Data sources:** `indexes.callers` from v0.2's stage 3.

### View 2 — "Big functions"

**Why someone looks:** "I'm reading this file to understand it. What's the longest function here?" Or: "Code review — what should I split?"

**What they do:** Click a big function → see callers + callees + body length → decide if it should be refactored. Click "open in editor" if the editor integration is wired.

**Layout:** Same shape as View 1, sorted by `endLine - line`. Filter by package, by kind (function/method/arrow). Top 30.

**Data sources:** Catalog directly (no index needed; iterate functions, sort by size).

### View 3 — "Wide functions"

**Why someone looks:** "What functions take too many parameters? Are there any I should refactor to take a config object?"

**What they do:** Click a wide function → see params with names and types → decide if a refactor is warranted.

**Layout:** Top 20 by `params.length`, descending. Show a thumbnail of the parameter list inline (e.g. `(output, baselinePath, options, retry, timeout, ...)`).

**Data sources:** Catalog `params` field. No index.

### View 4 — "Package coupling heat map"

**Why someone looks:** "What does our architecture actually look like? Which packages call which?" Or: "Is `core` really the bottom layer?"

**What they do:** See the matrix. Spot unexpected dependencies. Click a cell → see the actual call sites that produced the count → decide if a layer rule should be added or a refactor is needed.

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

Cells colored by call density. Empty cells mean "no calls in this direction." Click a cell → see the top-N call sites between those packages.

**Data sources:** Iterate every `calls[i].to` in the catalog; for each (caller-package, callee-package) pair, count.

### View 5 — "Untested production code"

**Why someone looks:** "Where am I missing tests? What's the highest-risk untested function?"

**What they do:** See production functions with no caller from any test file. Sort by `inboundCallCount` descending — most-called untested functions are the highest-risk gaps.

**Layout:** Sortable table. Function name, file, callers count (production-side), kind. Filter by package.

**Note:** Different from coverage tools (which measure line coverage at runtime). This view measures *static reachability from test code*. It catches things that *have a test* via dynamic dispatch but don't have a *static call*. Conservative — false positives possible — but cheap and uses only catalog data.

**Data sources:** Catalog `inTestFile` flag + `indexes.callers`.

### View 6 — "Strongly-connected components"

**Why someone looks:** "Is there code in this codebase that's tangled — a cluster of functions that all call each other? If so, where's the tightest knot?"

**What they do:** See SCCs of size > 1. Each is a cluster of functions in a mutual-recursion or reciprocal-dispatch shape. Click into the SCC → see all functions in the cluster → understand if it's intentional (e.g. a mutually-recursive parser) or accidental.

**Layout:** Sorted by component size descending. Top 10 components. Each row: size, member functions (preview), package(s) involved.

**Note:** SCCs of size 1 (every function is its own SCC) are not shown. Only size ≥ 2 — the actual coupling shape.

**Data sources:** Tarjan's SCC algorithm over the call graph. ~100 LOC of standard graph code, runs in O(V + E).

### View 7 — "Function search"

**Why someone looks:** "I want to find a function by name and explore its surroundings — callers, callees, file."

**What they do:** Type a name. Get a list. Click → drill down into the function's view (same as View 1's expanded card).

**Layout:** A search box at the top of the panel. Types fuzzy-match against `simpleName` and `qualifiedName`. Results show top 20 matches. Empty search shows "type to search" placeholder.

**Note:** This isn't a separate "view" so much as a search-bar always-visible component on the panel. It's a fast path to drill into any specific function without scrolling.

**Data sources:** `indexes.bySimpleName`.

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

This is the universal drill-down. Every "click a function" action opens this card. Closing the card returns to the prior view.

### 4.2 "Trace from entry point"

A button on the Function Card that runs a BFS from the inferred entry-point set down to the current function and shows the shortest path. Answers "how does code actually reach this function?" in one query.

If multiple entry points reach this function, the user sees the shortest path; a "show all paths" expansion shows others.

### 4.3 Filter chips

Across most views, the same filter chips at the top:
- Package multi-select
- Kind filter (function / method / arrow / constructor / getter / setter / module-init)
- Production/test toggle (default: production only)

Filters apply to the visible view; closing a Function Card and reopening another applies the same filters.

### 4.4 Editor deep-link

A button on the Function Card that produces a `vscode://file/<path>:<line>` URL (and similar for other editors). Clicking the button opens the editor. The protocol used is configurable in `opensip-tools.config.yml` under `dashboard.editor`. If unset, the button copies the path to clipboard instead.

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

## 6. Implementation phases

| Phase | What ships | Acceptance |
|---|---|---|
| **P0 — Skeleton** | Code Paths panel restructured to a tab system. The 7 view containers exist as empty cards. Existing finding-list view becomes "Findings" view. | All existing dashboard tests pass. |
| **P1 — Function Card** | The universal Function Card (overlay) is built. From the existing Findings view, every function name becomes clickable and opens the card. | Card displays correct callers, callees, body, params. |
| **P2 — View 1 (Hot)** | Hot Functions view with sort, filter, drill-into-card. | Top 50 sorted by callers count; click opens card. |
| **P3 — Views 2 + 3 (Big, Wide)** | Two more views, same shape as Hot. | Top N by body length / params count. |
| **P4 — View 4 (Coupling heat map)** | The package coupling matrix. Click cell → see top call sites. | Matrix renders for opensip-tools (~10 packages). |
| **P5 — View 5 (Untested)** | Production-with-no-test view. | Lists are correct against synthetic test fixtures. |
| **P6 — View 6 (SCCs)** | Tarjan's SCC implementation + view. | SCCs ≥ size 2 listed; opensip-tools may produce 0 (clean architecture). |
| **P7 — View 7 (Search)** | Search box + fuzzy match + drill-into-card. | Typing matches against simpleName + qualifiedName. |
| **P8 — Editor deep-link** | The "open in editor" button on the Function Card. | Click produces vscode:// URL or copies path. |
| **Phase T — Tests** | Per-view JS tests, integration tests. | Every view has at least 3 unit tests. |
| **Phase D — Docs** | Update `docs/architecture/60-surfaces/03-dashboard.md`. Add a v0.3 section to the architecture catalog. | Dashboard doc reflects the 7 views. |

P0–P3 is the v0.3 ship target. P4–P8 add views; ship as polish PRs.

---

## 7. Acceptance gates

For v0.3 to ship:

1. **All existing dashboard tests pass.** v0.3 doesn't break v0.2 dashboard.
2. **All workspace tests pass.** This is a contracts-package change; nothing else affected.
3. **Function Card renders correctly** for at least 5 functions covering different shapes (function, method, arrow, getter, constructor).
4. **All 7 views render without errors** when given a representative catalog (use opensip-tools catalog as the test input).
5. **The dashboard remains portable** — copy the report directory to a different machine and the panel works without any server.
6. **No new heavy dependency.** No React, no Vue, no D3 (heatmap is text-shaded HTML, not SVG).

---

## 8. Module layout

Inside `packages/contracts/src/persistence/dashboard/`:

```
code-paths.ts                    # Top-level panel — orchestrates tabs, embeds data, dispatches to views
code-paths/
  tabs.ts                        # Tab system (7 tabs)
  function-card.ts               # The universal drill-down overlay
  view-hot.ts                    # View 1
  view-big.ts                    # View 2
  view-wide.ts                   # View 3
  view-coupling.ts               # View 4 (heat map)
  view-untested.ts               # View 5
  view-sccs.ts                   # View 6
  view-search.ts                 # View 7
  scc.ts                         # Tarjan's algorithm
  filters.ts                     # Shared filter chip controls
  editor-link.ts                 # Deep-link generation
shared.ts                        # (existing — minor extensions for new card overlay CSS)
css.ts                           # (existing — add code-paths-specific styles)
```

~12 new files, each ≤200 LOC. Total ~1500 LOC of vanilla TS that compiles to inline JS in the static HTML.

---

## 9. Status

Draft, ready for review. Branch: `feat/graph-dashboard` (off main, contains the merged v0.2). Implementation begins after review.

The 6-phase improvement pipeline used on v0.2 should run on this plan too — same value: catches structural gaps, premature abstractions, missed concerns.

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
