/**
 * View registry — owns the singleton `views` array and the dispatch
 * helpers (`activateView(id)`, `renderActiveView()`).
 *
 * Each still-string-emitted `view-*` module pushes its own `View` literal into
 * `views` (resolved via the page global this bundle exposes). The panel
 * orchestrator iterates the registry to render tabs and to fan out
 * filter-change notifications.
 *
 * `activateView(id)` updates `location.hash` to `#code-paths/<id>` so
 * each view is deep-linkable.
 *
 * Reads the page globals `graphCatalog` / `graphIndexes` (declared by the panel
 * orchestrator, still string-emitted; typed in globals.ts).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { filterState } from './filters.js';

import type { ViewLike } from './code-paths-types.js';

export const views: ViewLike[] = [];
let activeViewId: string | null = null;

export function getView(id: string): ViewLike | null {
  // `views` is populated at runtime by the still-string-emitted `view-*` modules
  // (which `views.push(...)` against this exported array as the page global), so
  // it is NOT statically empty despite no push appearing in this module.
  // eslint-disable-next-line sonarjs/no-empty-collection -- populated by string-emitted view modules at load.
  for (const v of views) if (v.id === id) return v;
  return null;
}

export function renderActiveView(): void {
  if (!activeViewId) return;
  const view = getView(activeViewId);
  if (!view) return;
  const container = document.querySelector('#code-paths-view-' + view.id);
  if (!(container instanceof HTMLElement)) return;
  view.render(container, graphCatalog, graphIndexes, filterState);
}

export function activateView(id: string): void {
  const view = getView(id);
  if (!view) return;
  activeViewId = id;
  document.querySelectorAll<HTMLElement>('.code-paths-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === id);
  });
  document.querySelectorAll('.code-paths-view').forEach((p) => {
    p.classList.toggle('active', p.id === 'code-paths-view-' + id);
  });
  // Deep-link via hash, but don't loop on programmatic updates.
  const next = '#code-paths/' + id;
  if (globalThis.window !== undefined && globalThis.location.hash !== next) {
    try {
      history.replaceState(null, '', next);
    } catch {
      // @swallow-ok deep-linking is best-effort: history.replaceState throws in
      // sandboxed/file:// contexts where the report may be opened; the view still
      // activates, only the URL hash isn't updated.
    }
  }
  renderActiveView();
  if (typeof view.onActivate === 'function') {
    try {
      view.onActivate();
    } catch {
      // @swallow-ok onActivate is an optional, best-effort view hook (e.g. the
      // graph view's Cytoscape mount); a failure must not break view switching.
    }
  }
}
