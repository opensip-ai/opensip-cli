/**
 * Dashboard Code Paths panel — interactive seven-views explorer
 * (v0.3). Reads the embedded graph catalog (a `<script type=
 * "application/json" id="graph-catalog">` block) and renders the
 * Hot, Big, Wide, Coupling, Untested, SCCs, and Search views.
 *
 * Architecture: vanilla DOM, no framework. Each view-*.ts emits a
 * JS string that pushes a `View` literal into the singleton `views`
 * registry. The orchestrator (this file) wires the persistent search
 * input, filter chips, view tab bar, and seven empty containers.
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

  graphCatalog = loadGraphCatalogFromBlob();

  if (!graphCatalog) {
    panel.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'Code Paths' }),
      el('p', { class: 'muted', text: 'No graph sessions yet. Run opensip-tools graph to generate one.' }),
    ]));
    return;
  }

  graphIndexes = buildIndexes(graphCatalog);

  // Persistent search bar — always visible above the tabs.
  const search = el('input', {
    type: 'search',
    class: 'search-input code-paths-search',
    id: 'code-paths-search-input',
    placeholder: 'Search functions by name…',
  });
  panel.appendChild(search);

  // Filter chip bar — populated by filters.ts (Phase P3).
  const chips = el('div', { class: 'code-paths-filter-chips', id: 'code-paths-filter-chips' });
  panel.appendChild(chips);
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
  panel.appendChild(tabBar);

  // One container per view; only one is .active at a time.
  const stack = el('div', { class: 'code-paths-view-container', id: 'code-paths-view-container' });
  for (const view of views) {
    const c = el('div', { class: 'code-paths-view', id: 'code-paths-view-' + view.id });
    stack.appendChild(c);
  }
  panel.appendChild(stack);

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

  // Render every view once on init (so hidden views are populated for
  // when the user activates them). Then respect the URL hash if it
  // matches a known view.
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
`;
}
