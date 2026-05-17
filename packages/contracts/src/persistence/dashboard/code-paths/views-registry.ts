/**
 * View registry — emits the singleton `views = []` and the dispatch
 * helpers (`activateView(id)`, `renderActiveView()`).
 *
 * Each `view-*.ts` file pushes its own `View` literal into `views`. The
 * panel orchestrator iterates the registry to render tabs and to fan
 * out filter-change notifications (§10.1 / §10.3).
 *
 * `activateView(id)` updates `location.hash` to `#code-paths/<id>` so
 * each view is deep-linkable (§7 Phase P3 step 4).
 */

export function dashboardViewsRegistryJs(): string {
  return String.raw`
const views = [];
let activeViewId = null;

function getView(id) {
  for (const v of views) if (v.id === id) return v;
  return null;
}

function renderActiveView() {
  if (!activeViewId) return;
  const view = getView(activeViewId);
  if (!view) return;
  const container = document.getElementById('code-paths-view-' + view.id);
  if (!container) return;
  view.render(container, graphCatalog, graphIndexes, filterState);
}

function activateView(id) {
  const view = getView(id);
  if (!view) return;
  activeViewId = id;
  document.querySelectorAll('.code-paths-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === id);
  });
  document.querySelectorAll('.code-paths-view').forEach(p => {
    p.classList.toggle('active', p.id === 'code-paths-view-' + id);
  });
  // Deep-link via hash, but don't loop on programmatic updates.
  const next = '#code-paths/' + id;
  if (typeof window !== 'undefined' && window.location.hash !== next) {
    try { history.replaceState(null, '', next); } catch (e) { /* ignore */ }
  }
  renderActiveView();
}
`;
}
