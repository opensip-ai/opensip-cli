// @fitness-ignore-file module-coupling-fan-out -- Panel aggregator: composes JS-string emitters from sibling view-*.ts modules; fan-out is intrinsic to its role as the entry point
/**
 * Dashboard Code Paths panel — graph-tool surface with two subtabs:
 *   1. Sessions — recent graph runs and their per-rule findings
 *      (uses the shared renderSessionTable from sessions.ts).
 *   2. Explore — interactive catalog browser with three views
 *      (Graph, Coupling, Functions/distribution). The Graph view
 *      carries the SCC cycle highlight that the standalone SCCs view
 *      used to own. The Functions view absorbs the former standalone
 *      Search subtab via an in-table name filter.
 *
 * Architecture: vanilla DOM, no framework. Each view-*.ts emits a
 * JS string that pushes a `View` literal into the singleton `views`
 * registry. The Explore subtab renders the view tab bar + one
 * container per view; Sessions subtab renders the standard session
 * table.
 *
 * The file imports JS-string emitters from sibling modules under
 * `code-paths/`. It MUST NOT import from `@opensip-cli/graph` —
 * the catalog is consumed by JSON shape only (the structural shape
 * lives in @opensip-cli/contracts to keep this panel decoupled
 * from the graph engine's runtime types).
 */

import { dashboardCatalogProvenanceJs } from './code-paths/catalog-provenance.js';
import { dashboardCatalogRecipesTablesJs } from './code-paths/catalog-recipes-tables.js';
import { dashboardCytoscapeVendorJs } from './code-paths/cytoscape-vendor.js';
import { dashboardEditorLinkJs } from './code-paths/editor-link.js';
import { dashboardFiltersJs } from './code-paths/filters.js';
import { dashboardFunctionCardJs } from './code-paths/function-card.js';
import { dashboardFunctionRowJs } from './code-paths/function-row.js';
import { dashboardHelpDrawerJs } from './code-paths/help-drawer.js';
import { dashboardIndexesJs } from './code-paths/indexes.js';
import { dashboardPathUtilsJs } from './code-paths/path-utils.js';
import { dashboardSearchJs } from './code-paths/search.js';
import { dashboardTraceJs } from './code-paths/trace.js';
import { dashboardViewCouplingJs } from './code-paths/view-coupling.js';
import { dashboardViewDistributionJs } from './code-paths/view-distribution.js';
import { dashboardViewGraphJs } from './code-paths/view-graph.js';
import { dashboardViewsRegistryJs } from './code-paths/views-registry.js';

/**
 * Build flag for the Code Paths explore-tab restructure.
 *
 * `true` (Plan D default, current): the restructured set — graph (with the
 * SCC-highlight fold) / coupling + the ranked-distribution "Functions"
 * affordance (which hosts the in-table name filter that replaced the
 * former standalone Search subtab). The legacy single-metric views
 * (`view-big/hot/wide/untested/sccs`) were deleted in Plan D once their
 * signal moved into the engine gate rules (`graph:large-function`,
 * `graph:wide-function`, `graph:high-blast-untested`, `graph:cycle`); the
 * standalone SCCs view's signal lives on as the graph view's cycle highlight.
 *
 * `false`: there is no legacy branch anymore — the constant is retained only
 * as the default for the `dashboardCodePathsJs(restructured)` test seam, which
 * always exercises the restructured set.
 *
 * This is a build-time, server-side seam — no runtime toggle in the page.
 */
const RESTRUCTURED_EXPLORE_TABS = true;

/**
 * Concatenation order is load-bearing — each emitter declares
 * top-level names that later emitters reference. The order below is
 * the topological sort; reordering will silently break the page with
 * `<name> is not defined`. Free-identifier dependencies of each
 * emitter, listed against the emitter that supplies them:
 *
 *  1. path-utils       — declares `displayName`, `packageOfPath`, `pkgOf`,
 *                        `shortPkg`.
 *  2. indexes          — declares `buildIndexes`, `resolveCalleeOcc`. Uses
 *                        `pkgOf` (path-utils, above).
 *  3. filters          — declares `filterState` (default, non-interactive),
 *                        `passesFilter`, `packagesInCatalog`, `KIND_LIST`.
 *                        Uses `pkgOf` (path-utils, above).
 *  4. editor-link      — declares `editorLink`. Reads `EDITOR_PROTOCOL`
 *                        (declared in generator.ts before the script
 *                        block).
 *  5. trace            — declares `findUpstreamTrace`. Uses `indexes`.
 *  6. search           — declares `searchFunctions`. Uses `indexes`,
 *                        `displayName`.
 *  7. function-row     — declares `renderFunctionRows` and the empty
 *                        states it uses. Calls `el`, `displayName`,
 *                        `packageOfPath`, `passesFilter`.
 *  8. function-card    — declares `openFunctionCard`, `closeFunctionCard`.
 *                        Uses `editorLink`, `findUpstreamTrace`, `el`.
 *  9. views-registry   — declares the singleton `views = []` array.
 *                        Must come before any view emitter.
 * 10. help-drawer      — declares `openHelpDrawer`. No external deps
 *                        beyond `el`.
 * 11-13. view-*        — push View descriptors into `views` in TAB order:
 *                        coupling / distribution / graph (alphabetical:
 *                        Coupling, Functions, Visualization — the first is the
 *                        default view). Each renderer closes over `el`,
 *                        `passesFilter`, `displayName`, `packageOfPath`,
 *                        `renderFunctionRows`, plus its own utilities; the
 *                        Visualization renderer also uses `resolveCalleeOcc`
 *                        (prelude) for its function-level projection.
 * 15. panelOrchestrator — top-level `renderCodePathsTab`,
 *                        `renderCodePathsExplore`, `openCodePathsSession`.
 *                        Uses every name above plus `renderSubtabBar`
 *                        (from shared/) and `registerTabActivator`.
 *
 * If the list grows past ~30 entries, replace this manual order with
 * a `{ id, deps, emit }` topological sort.
 */
export function dashboardCodePathsJs(_restructured: boolean = RESTRUCTURED_EXPLORE_TABS): string {
  // The explore-tab restructure has shipped: there is one view set (coupling /
  // distribution / graph). The `_restructured` parameter is kept
  // for the test seam's call-shape compatibility but no longer selects a
  // legacy branch (the single-metric view emitters were deleted in Plan D).
  // Shared prelude — utilities + the views registry + help drawer. Every view
  // emitter depends on these top-level names.
  const prelude = [
    // 0. cytoscape vendor — defines the `cytoscape` / `cytoscapeDagre`
    //    browser globals the Graph view consumes. MUST precede any view
    //    emitter that references them. No deps of its own.
    dashboardCytoscapeVendorJs(),
    dashboardPathUtilsJs(),
    dashboardIndexesJs(),
    dashboardFiltersJs(),
    // Depends on `packagesInCatalog` (filters, above) + `el`; declares
    // `renderCatalogProvenance`, called at the top of the Explore body.
    dashboardCatalogProvenanceJs(),
    // Declares `renderGraphRuleCatalog` / `renderGraphRecipeCatalog` (the
    // Catalog/Recipes subtab tables); only needs `el`.
    dashboardCatalogRecipesTablesJs(),
    dashboardEditorLinkJs(),
    dashboardTraceJs(),
    dashboardSearchJs(),
    dashboardFunctionRowJs(),
    dashboardFunctionCardJs(),
    dashboardViewsRegistryJs(),
    dashboardHelpDrawerJs(),
  ];

  // The kept visualizations + the ranked-distribution affordance, in TAB
  // order (alphabetical): Coupling, Functions, Visualization. `views[0]` is
  // the default view, so Coupling opens first. SCCs fold into the graph view's
  // cycle highlight; the single-metric tabs were dropped (their signal moved
  // into the engine gate rules). `renderCodePathsExplore` iterates `views` to
  // build the tab bar. Emission order here is also the runtime registry order;
  // the three view emitters have no cross-dependencies (each only references
  // prelude names), so this order is free to match the desired tab order.
  const views = [dashboardViewCouplingJs(), dashboardViewDistributionJs(), dashboardViewGraphJs()];

  return [...prelude, ...views, panelOrchestratorJs()].join('\n');
}

/**
 * Top-level orchestrator emitter for the Code Paths tab. Concerns,
 * with the section delimiters that mark them in the emitted JS:
 *
 *   1. CATALOG STATE — singleton `graphCatalog` and `graphIndexes`.
 *   2. CATALOG LOAD — `loadGraphCatalogFromBlob` reads the inline
 *      `<script id="graph-catalog">` blob.
 *   3. PANEL ENTRY — `renderCodePathsTab` mounts the Sessions /
 *      Explore subtabs via `renderSubtabBar` (F2).
 *   4. EXPLORE BODY — `renderCodePathsExplore` builds the view tab
 *      bar, view containers, row-click delegation, escape handler,
 *      and runs each view's initial render.
 *   5. HASH ROUTE — `readViewIdFromHash` parses `#code-paths/<id>`
 *      for deep-link initial view.
 *   6. CROSS-TAB NAV — `openCodePathsSession` is the activator
 *      Overview's row-click handler invokes via
 *      `activateTabForSession` for graph sessions.
 *   7. ACTIVATOR REGISTRATION — registers `openCodePathsSession`
 *      under key `'graph'` in the shared `tabActivators` registry.
 *
 * The escape handler in EXPLORE BODY is attached to `document`; if
 * `renderCodePathsTab` runs more than once (it does not today) the
 * handler would leak.
 */
function panelOrchestratorJs(): string {
  return String.raw`
// =======================================================
// CODE PATHS — CATALOG STATE
// =======================================================
let graphCatalog = null;
let graphIndexes = { byBodyHash: new Map(), occurrencesByHash: new Map(), bySimpleName: new Map(), callees: new Map(), callers: new Map() };

// =======================================================
// CODE PATHS — CATALOG LOAD
// =======================================================
function loadGraphCatalogFromBlob() {
  const blob = document.getElementById('graph-catalog');
  if (!blob || !blob.textContent) return null;
  try {
    return JSON.parse(blob.textContent);
  } catch (err) {
    return null;
  }
}

// =======================================================
// CODE PATHS — PANEL ENTRY (Sessions | Explore subtabs)
// =======================================================
function renderCodePathsTab() {
  const panel = document.getElementById('panel-code-paths');
  if (!panel) return;
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  const graphSessions = sessions.filter(s => s.tool === 'graph');
  graphCatalog = loadGraphCatalogFromBlob();

  // Code Paths uses the shared renderSubtabBar Strategy (F2). The
  // two-subtab Sessions/Explore shape is a config; the DOM-and-click
  // boilerplate now lives in subtab-bar.ts and is shared with
  // renderToolTab's three-subtab shape. The subtabs render even when
  // empty so the tab matches the visual pattern used by Fitness and
  // Simulation (subtab bar + italic-centered .empty placeholder).
  renderSubtabBar(panel, [
    {
      id: 'sessions',
      label: 'Sessions',
      render: function(p) {
        if (graphSessions.length > 0) {
          renderSessionTable(p, graphSessions, 'var(--accent)');
        } else {
          p.appendChild(el('div', { class: 'empty', text: 'No sessions yet.' }));
        }
      },
    },
    {
      id: 'catalog',
      label: 'Catalog',
      render: function(p) {
        renderGraphRuleCatalog(p, typeof graphRuleCatalog !== 'undefined' ? graphRuleCatalog : []);
      },
    },
    {
      id: 'recipes',
      label: 'Recipes',
      render: function(p) {
        renderGraphRecipeCatalog(p, typeof graphRecipeCatalog !== 'undefined' ? graphRecipeCatalog : []);
      },
    },
    {
      id: 'explore',
      label: 'Explore',
      render: function(p) {
        if (graphCatalog) {
          renderCodePathsExplore(p);
        } else {
          p.appendChild(el('div', { class: 'empty', text: 'No catalog yet.' }));
        }
      },
    },
  ]);
}

// =======================================================
// CODE PATHS — EXPLORE BODY (view tab bar + view stack)
// =======================================================
function renderCodePathsExplore(host) {
  graphIndexes = buildIndexes(graphCatalog);

  // Provenance bar — what this Explore view is built from (package scope,
  // function count, build time, engine). Shown above the view tabs so a SCOPED
  // or stale catalog (e.g. a 'graph packages/contracts' run) reads as "1
  // package, built 8 min ago", not as a broken/empty graph. Covers all three
  // views since they share the one cached catalog.
  renderCatalogProvenance(host, graphCatalog);

  // (No shared filter chip bar — the Visualization view owns its own controls;
  // the Functions table reads the default filterState via passesFilter.)

  // View tab bar — built from the registered views.
  const tabBar = el('div', { class: 'code-paths-tabs', id: 'code-paths-tabs' });
  for (const view of views) {
    const tab = el('div', {
      class: 'code-paths-tab',
      'data-view': view.id,
      text: view.label,
      onclick: () => activateView(view.id),
    });
    tabBar.appendChild(tab);
  }
  host.appendChild(tabBar);

  // One container per view; only one is .active at a time.
  const stack = el('div', { class: 'code-paths-view-container', id: 'code-paths-view-container' });
  for (const view of views) {
    const c = el('div', { class: 'code-paths-view', id: 'code-paths-view-' + view.id });
    stack.appendChild(c);
  }
  host.appendChild(stack);

  // Delegate row clicks to the function card.
  stack.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('[data-body-hash]');
    if (!row) return;
    openFunctionCard(row.dataset.bodyHash);
  });

  // Escape closes the function card.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeFunctionCard();
  });

  // Render every view once on init.
  for (const view of views) {
    const container = document.getElementById('code-paths-view-' + view.id);
    if (container) view.render(container, graphCatalog, graphIndexes, filterState);
  }
  const initialId = readViewIdFromHash() || (views[0] && views[0].id);
  if (initialId) activateView(initialId);
}

// =======================================================
// CODE PATHS — HASH ROUTE (deep-link initial view)
// =======================================================
function readViewIdFromHash() {
  const m = /^#code-paths\/([a-z]+)/.exec(window.location.hash || '');
  return m ? m[1] : null;
}

// =======================================================
// CODE PATHS — CROSS-TAB NAV (graph sessions deep-link)
// =======================================================
/**
 * Open the Code Paths tab on the Sessions subtab, scrolling to and
 * selecting the row matching the given session id. Used by the
 * Overview row-click handler so a graph row in Recent Activity opens
 * the same per-session detail view that fit/sim rows open.
 *
 * Registered into the shared tabActivators registry under the key
 * 'graph' (the StoredSession.tool value for graph runs); the Overview
 * row-click handler invokes it through activateTabForSession() rather
 * than naming this function directly.
 */
function openCodePathsSession(sessionId) {
  const tab = document.querySelector('.tab[data-tab="code-paths"]');
  const panel = document.getElementById('panel-code-paths');
  if (!tab || !panel) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  panel.classList.add('active');
  // Force the Sessions subtab.
  const sessionsSub = panel.querySelector('.subtab[data-subtab="sessions"]');
  const exploreSub = panel.querySelector('.subtab[data-subtab="explore"]');
  const sessionsPanel = document.getElementById('panel-code-paths-sessions');
  const explorePanel = document.getElementById('panel-code-paths-explore');
  if (sessionsSub) sessionsSub.classList.add('active');
  if (exploreSub) exploreSub.classList.remove('active');
  if (sessionsPanel) sessionsPanel.classList.add('active');
  if (explorePanel) explorePanel.classList.remove('active');
  // Click the matching row to trigger the standard renderDetail flow.
  const row = sessionsPanel && sessionsPanel.querySelector('tr[data-session-id="' + sessionId + '"]');
  if (row) row.click();
}

// =======================================================
// CODE PATHS — ACTIVATOR REGISTRATION
// =======================================================
if (typeof registerTabActivator === 'function') {
  registerTabActivator('graph', openCodePathsSession);
}
`;
}
