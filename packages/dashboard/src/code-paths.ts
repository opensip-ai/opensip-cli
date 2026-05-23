/**
 * Dashboard Code Paths panel — graph-tool surface with two subtabs:
 *   1. Sessions — recent graph runs and their per-rule findings
 *      (uses the shared renderSessionTable from sessions.ts).
 *   2. Explore — interactive seven-views catalog browser
 *      (Hot, Big, Wide, Coupling, Untested, SCCs, Search).
 *
 * Architecture: vanilla DOM, no framework. Each view-*.ts emits a
 * JS string that pushes a `View` literal into the singleton `views`
 * registry. The Explore subtab renders filter chips + view tab bar
 * + seven view containers; Sessions subtab renders the standard
 * session table.
 *
 * The file imports JS-string emitters from sibling modules under
 * `code-paths/`. It MUST NOT import from `@opensip-tools/graph` —
 * the catalog is consumed by JSON shape only (see §2.4 of
 * docs/plans/graph-dashboard-v3-design.md).
 */

import { dashboardEditorLinkJs } from './code-paths/editor-link.js';
import { dashboardFiltersJs } from './code-paths/filters.js';
import { dashboardFunctionCardJs } from './code-paths/function-card.js';
import { dashboardFunctionRowJs } from './code-paths/function-row.js';
import { dashboardHelpDrawerJs } from './code-paths/help-drawer.js';
import { dashboardIndexesJs } from './code-paths/indexes.js';
import { dashboardPathUtilsJs } from './code-paths/path-utils.js';
import { dashboardSccJs } from './code-paths/scc.js';
import { dashboardSearchJs } from './code-paths/search.js';
import { dashboardTraceJs } from './code-paths/trace.js';
import { dashboardViewBigJs } from './code-paths/view-big.js';
import { dashboardViewCouplingJs } from './code-paths/view-coupling.js';
import { dashboardViewHotJs } from './code-paths/view-hot.js';
import { dashboardViewSccsJs } from './code-paths/view-sccs.js';
import { dashboardViewSearchJs } from './code-paths/view-search.js';
import { dashboardViewUntestedJs } from './code-paths/view-untested.js';
import { dashboardViewWideJs } from './code-paths/view-wide.js';
import { dashboardViewsRegistryJs } from './code-paths/views-registry.js';

export function dashboardCodePathsJs(): string {
  return [
    dashboardPathUtilsJs(),
    dashboardIndexesJs(),
    dashboardFiltersJs(),
    dashboardEditorLinkJs(),
    dashboardTraceJs(),
    dashboardSccJs(),
    dashboardSearchJs(),
    dashboardFunctionRowJs(),
    dashboardFunctionCardJs(),
    dashboardViewsRegistryJs(),
    dashboardHelpDrawerJs(),
    dashboardViewHotJs(),
    dashboardViewBigJs(),
    dashboardViewWideJs(),
    dashboardViewCouplingJs(),
    dashboardViewUntestedJs(),
    dashboardViewSccsJs(),
    dashboardViewSearchJs(),
    panelOrchestratorJs(),
  ].join('\n');
}

function panelOrchestratorJs(): string {
  return String.raw`
let graphCatalog = null;
let graphIndexes = { byBodyHash: new Map(), bySimpleName: new Map(), callees: new Map(), callers: new Map() };

function loadGraphCatalogFromBlob() {
  const blob = document.getElementById('graph-catalog');
  if (!blob || !blob.textContent) return null;
  try {
    return JSON.parse(blob.textContent);
  } catch (err) {
    return null;
  }
}

function renderCodePathsTab() {
  const panel = document.getElementById('panel-code-paths');
  if (!panel) return;
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  const graphSessions = sessions.filter(s => s.tool === 'graph');
  graphCatalog = loadGraphCatalogFromBlob();

  if (graphSessions.length === 0 && !graphCatalog) {
    panel.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'Code Paths' }),
      el('p', { class: 'muted', text: 'No graph sessions yet. Run opensip-tools graph to generate one.' }),
    ]));
    return;
  }

  // Subtab bar (Sessions | Explore). Mirrors fit/sim's subtab pattern
  // visually; built directly here because Code Paths' two-tab shape
  // doesn't fit renderToolTab's three-tab Overview/Catalog/Recipes mold.
  const subtabBar = el('div', { class: 'subtab-bar' });
  const sessionsSub = el('div', { class: 'subtab active', 'data-subtab': 'sessions', text: 'Sessions' });
  const exploreSub = el('div', { class: 'subtab', 'data-subtab': 'explore', text: 'Explore' });
  subtabBar.appendChild(sessionsSub);
  subtabBar.appendChild(exploreSub);
  panel.appendChild(subtabBar);

  const sessionsPanel = el('div', { class: 'subtab-panel active', id: 'panel-code-paths-sessions' });
  const explorePanel = el('div', { class: 'subtab-panel', id: 'panel-code-paths-explore' });
  panel.appendChild(sessionsPanel);
  panel.appendChild(explorePanel);

  subtabBar.addEventListener('click', e => {
    const tab = e.target.closest('.subtab');
    if (!tab) return;
    subtabBar.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    sessionsPanel.classList.toggle('active', tab.dataset.subtab === 'sessions');
    explorePanel.classList.toggle('active', tab.dataset.subtab === 'explore');
  });

  // Sessions subtab: shared session table (same UX as fit/sim).
  if (graphSessions.length > 0) {
    renderSessionTable(sessionsPanel, graphSessions, 'var(--accent)');
  } else {
    sessionsPanel.appendChild(el('div', { class: 'empty', text: 'No graph sessions yet.' }));
  }

  // Explore subtab: catalog views. Only meaningful with a catalog.
  if (graphCatalog) {
    renderCodePathsExplore(explorePanel);
  } else {
    explorePanel.appendChild(el('div', { class: 'empty', text: 'Catalog cache missing. Re-run opensip-tools graph to populate.' }));
  }
}

function renderCodePathsExplore(host) {
  graphIndexes = buildIndexes(graphCatalog);

  // Filter chip bar.
  const chips = el('div', { class: 'code-paths-filter-chips', id: 'code-paths-filter-chips' });
  host.appendChild(chips);
  renderFilterChips(chips, graphCatalog);

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

function readViewIdFromHash() {
  const m = /^#code-paths\/([a-z]+)/.exec(window.location.hash || '');
  return m ? m[1] : null;
}

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

if (typeof registerTabActivator === 'function') {
  registerTabActivator('graph', openCodePathsSession);
}
`;
}
