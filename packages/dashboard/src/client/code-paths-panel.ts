/**
 * Code Paths panel orchestrator — the graph-tool surface.
 *
 * Two subtabs: Sessions (recent graph runs + per-rule findings, via the shared
 * `renderSessionTable`) and Explore (interactive catalog browser with the three
 * registered views — Coupling, Functions, Visualization), plus Catalog and
 * Recipes subtabs for the graph rule/recipe catalogs.
 *
 * Concerns:
 *   1. CATALOG STATE — the singleton `graphCatalog` / `graphIndexes`.
 *   2. CATALOG LOAD — reads the inline `<script id="graph-catalog">` blob.
 *   3. PANEL ENTRY — `renderCodePathsTab` mounts the subtabs via renderSubtabBar.
 *   4. EXPLORE BODY — builds the view tab bar, view containers, row-click
 *      delegation, escape handler, and runs each view's initial render.
 *   5. HASH ROUTE — parses `#code-paths/<id>` for the deep-link initial view.
 *   6. CROSS-TAB NAV — `openCodePathsSession`, the activator Overview invokes
 *      via `activateTabForSession` for graph sessions.
 *   7. ACTIVATOR REGISTRATION — registers under key `'graph'` at load.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 *
 * ## Catalog-state bridge
 * The migrated views (view-coupling / view-graph) and the Function Card read
 * `graphCatalog` / `graphIndexes` as page globals (declared in globals.ts). This
 * orchestrator OWNS those mutable bindings: it assigns them to `globalThis` so
 * the rest of the bundle resolves the same singletons. Keeping the global bridge
 * (rather than a shared module binding) preserves the documented incremental-
 * migration contract and the existing jsdom test harnesses that seed the
 * catalog through the page scope.
 */

import { renderCatalogProvenance } from './catalog-provenance.js';
import {
  renderGraphRecipeCatalog,
  renderGraphRuleCatalog,
  type GraphRecipeEntry,
  type GraphRuleEntry,
} from './catalog-recipes-tables.js';
import { el } from './el.js';
import { filterState } from './filters.js';
import { closeFunctionCard, openFunctionCard } from './function-card.js';
import { buildIndexes } from './indexes.js';
import { renderSessionTable } from './sessions.js';
import { renderSubtabBar } from './subtab-bar.js';
import { registerTabActivator } from './tab-activators.js';
import { activateView, views } from './views-registry.js';
// view-coupling / view-distribution / view-graph register themselves into the
// `views` array as a load-time side effect. Importing them here (the panel is
// the Code Paths entry point) guarantees they are bundled and registered before
// the panel renders the Explore tab bar.
import './view-coupling.js';
import './view-distribution.js';
import './view-graph.js';

import type { CatalogLike } from './code-paths-types.js';

/** The bundle reads `graphCatalog` / `graphIndexes` as page globals. */
interface CatalogGlobals {
  graphCatalog: CatalogLike | null;
  graphIndexes: ReturnType<typeof buildIndexes>;
}
const cg = globalThis as typeof globalThis & CatalogGlobals;

// =======================================================
// CODE PATHS — CATALOG STATE (page globals; see header note)
// =======================================================
cg.graphCatalog = null;
cg.graphIndexes = {
  byBodyHash: new Map(),
  occurrencesByHash: new Map(),
  bySimpleName: new Map(),
  callees: new Map(),
  callers: new Map(),
};

// =======================================================
// CODE PATHS — CATALOG LOAD
// =======================================================
function loadGraphCatalogFromBlob(): CatalogLike | null {
  const blob = document.querySelector('#graph-catalog');
  if (!blob?.textContent) return null;
  try {
    return JSON.parse(blob.textContent) as CatalogLike;
  } catch {
    // @swallow-ok a malformed embedded catalog blob is treated as "no catalog" —
    // the Explore subtab shows its empty state. No logger in the browser bundle.
    return null;
  }
}

// =======================================================
// CODE PATHS — PANEL ENTRY (Sessions | Catalog | Recipes | Explore subtabs)
// =======================================================
export function renderCodePathsTab(): void {
  const panel = document.querySelector<HTMLElement>('#panel-code-paths');
  if (!panel) return;
  while (panel.firstChild) panel.firstChild.remove();

  const graphSessions = sessions.filter((s) => s.tool === 'graph');
  cg.graphCatalog = loadGraphCatalogFromBlob();

  // Code Paths uses the shared renderSubtabBar Strategy (F2). The subtabs render
  // even when empty so the tab matches the visual pattern used by Fitness and
  // Simulation (subtab bar + italic-centered .empty placeholder).
  renderSubtabBar(panel, [
    {
      id: 'sessions',
      label: 'Sessions',
      render(p) {
        if (graphSessions.length > 0) {
          renderSessionTable(p, graphSessions, 'var(--accent)');
        } else {
          p.append(el('div', { class: 'empty', text: 'No sessions yet.' }));
        }
      },
    },
    {
      id: 'catalog',
      label: 'Catalog',
      render(p) {
        // The graph rule/recipe catalogs are tool-owned, inlined as JSON and
        // read structurally by the renderers; cast the opaque `unknown[]` page
        // globals to the renderers' structural entry shapes.
        renderGraphRuleCatalog(
          p,
          typeof graphRuleCatalog === 'undefined'
            ? []
            : (graphRuleCatalog as readonly GraphRuleEntry[]),
        );
      },
    },
    {
      id: 'recipes',
      label: 'Recipes',
      render(p) {
        renderGraphRecipeCatalog(
          p,
          typeof graphRecipeCatalog === 'undefined'
            ? []
            : (graphRecipeCatalog as readonly GraphRecipeEntry[]),
        );
      },
    },
    {
      id: 'explore',
      label: 'Explore',
      render(p) {
        if (cg.graphCatalog) {
          renderCodePathsExplore(p);
        } else {
          p.append(el('div', { class: 'empty', text: 'No catalog yet.' }));
        }
      },
    },
  ]);
}

// =======================================================
// CODE PATHS — EXPLORE BODY (view tab bar + view stack)
// =======================================================
function renderCodePathsExplore(host: HTMLElement): void {
  cg.graphIndexes = buildIndexes(cg.graphCatalog);

  // Provenance bar — what this Explore view is built from (package scope,
  // function count, build time, engine). Shown above the view tabs so a SCOPED
  // or stale catalog reads clearly. Covers all three views since they share the
  // one cached catalog.
  renderCatalogProvenance(host, cg.graphCatalog);

  // View tab bar — built from the registered views.
  const tabBar = el('div', { class: 'code-paths-tabs', id: 'code-paths-tabs' });
  for (const view of views) {
    const tab = el('div', {
      class: 'code-paths-tab',
      'data-view': view.id,
      text: view.label,
      onclick: () => activateView(view.id),
    });
    tabBar.append(tab);
  }
  host.append(tabBar);

  // One container per view; only one is .active at a time.
  const stack = el('div', { class: 'code-paths-view-container', id: 'code-paths-view-container' });
  for (const view of views) {
    const c = el('div', { class: 'code-paths-view', id: 'code-paths-view-' + view.id });
    stack.append(c);
  }
  host.append(stack);

  // Delegate row clicks to the function card.
  stack.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const row = target?.closest?.<HTMLElement>('[data-body-hash]');
    if (!row) return;
    openFunctionCard(row.dataset.bodyHash ?? '');
  });

  // Escape closes the function card.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFunctionCard();
  });

  // Render every view once on init.
  for (const view of views) {
    const container = document.querySelector<HTMLElement>('#code-paths-view-' + view.id);
    if (container) view.render(container, cg.graphCatalog, cg.graphIndexes, filterState);
  }
  const hashId = readViewIdFromHash();
  const initialId = hashId ?? views[0]?.id;
  // Only write the hash when the URL already deep-links a view (Option 1).
  // Silent init keeps `latest.html` clean until the reader clicks an Explore tab.
  if (initialId) activateView(initialId, { updateHash: hashId !== null });
}

// =======================================================
// CODE PATHS — HASH ROUTE (deep-link initial view)
// =======================================================
function readViewIdFromHash(): string | null {
  const m = /^#code-paths\/([a-z]+)/.exec(globalThis.location.hash || '');
  return m ? m[1] : null;
}

// =======================================================
// CODE PATHS — CROSS-TAB NAV (graph sessions deep-link)
// =======================================================
/**
 * Open the Code Paths tab on the Sessions subtab, scrolling to and selecting the
 * row matching the given session id. Used by the Overview row-click handler so a
 * graph row in Recent Activity opens the same per-session detail view that
 * fit/sim rows open. Registered into the shared tabActivators registry under the
 * key 'graph'.
 */
export function openCodePathsSession(sessionId: string): void {
  const tab = document.querySelector('.tab[data-tab="code-paths"]');
  const panel = document.querySelector('#panel-code-paths');
  if (!tab || !panel) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  panel.classList.add('active');
  // Force the Sessions subtab.
  const sessionsSub = panel.querySelector('.subtab[data-subtab="sessions"]');
  const exploreSub = panel.querySelector('.subtab[data-subtab="explore"]');
  const sessionsPanel = document.querySelector('#panel-code-paths-sessions');
  const explorePanel = document.querySelector('#panel-code-paths-explore');
  if (sessionsSub) sessionsSub.classList.add('active');
  if (exploreSub) exploreSub.classList.remove('active');
  if (sessionsPanel) sessionsPanel.classList.add('active');
  if (explorePanel) explorePanel.classList.remove('active');
  // Click the matching row to trigger the standard renderDetail flow.
  const row = sessionsPanel?.querySelector<HTMLElement>('tr[data-session-id="' + sessionId + '"]');
  if (row) row.click();
}

// =======================================================
// CODE PATHS — ACTIVATOR REGISTRATION
// =======================================================
registerTabActivator('graph', openCodePathsSession);
