/**
 * View registry — owns the singleton `views` array and the dispatch
 * helpers (`activateView(id)`, `renderActiveView()`).
 *
 * Each still-string-emitted `view-*` module pushes its own `View` literal into
 * `views` (resolved via the page global this bundle exposes). The panel
 * orchestrator iterates the registry to render tabs and to fan out
 * filter-change notifications.
 *
 * `activateView(id)` activates a Code Paths Explore view. By default it also
 * updates `location.hash` to `#code-paths/<id>` so each view is deep-linkable;
 * pass `{ updateHash: false }` on silent init when the URL has no hash yet.
 *
 * Reads the page globals `graphCatalog` / `graphIndexes` (declared by the panel
 * orchestrator, still string-emitted; typed in globals.ts).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { filterState } from './filters.js';

import type { CatalogLike, IndexesLike, ViewLike } from './code-paths-types.js';

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

function showViewFailure(view: ViewLike, container: HTMLElement, action: string): void {
  const notice = document.createElement('div');
  notice.className = 'empty';
  notice.setAttribute('role', 'status');
  notice.textContent = view.label + ' could not be ' + action + '. Other views remain available.';
  container.replaceChildren(notice);
}

/** Invoke a registered extension view without allowing it to unwind the report. */
export function renderRegisteredView(
  view: ViewLike,
  container: HTMLElement,
  catalog: CatalogLike | null,
  indexes: IndexesLike,
): boolean {
  try {
    view.render(container, catalog, indexes, filterState);
    return true;
  } catch {
    showViewFailure(view, container, 'rendered');
    // @swallow-ok the extension failure is replaced with a visible in-page notice.
    return false;
  }
}

export function renderActiveView(): boolean {
  if (!activeViewId) return false;
  const view = getView(activeViewId);
  if (!view) return false;
  const container = document.querySelector('#code-paths-view-' + view.id);
  if (!(container instanceof HTMLElement)) return false;
  return renderRegisteredView(view, container, graphCatalog, graphIndexes);
}

export interface ActivateViewOptions {
  /** When false, activate the view without writing `#code-paths/<id>` to the URL. */
  updateHash?: boolean;
}

export function activateView(id: string, options: ActivateViewOptions = {}): void {
  const view = getView(id);
  if (!view) return;
  activeViewId = id;
  document.querySelectorAll<HTMLElement>('.code-paths-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === id);
  });
  document.querySelectorAll('.code-paths-view').forEach((p) => {
    p.classList.toggle('active', p.id === 'code-paths-view-' + id);
  });
  const updateHash = options.updateHash !== false;
  // Deep-link via hash, but don't loop on programmatic updates.
  const next = '#code-paths/' + id;
  if (updateHash && globalThis.window !== undefined && globalThis.location.hash !== next) {
    try {
      history.replaceState(null, '', next);
    } catch {
      // @swallow-ok deep-linking is best-effort: history.replaceState throws in
      // sandboxed/file:// contexts where the report may be opened; the view still
      // activates, only the URL hash isn't updated.
    }
  }
  if (!renderActiveView()) return;
  if (typeof view.onActivate === 'function') {
    try {
      view.onActivate();
    } catch {
      const container = document.querySelector<HTMLElement>('#code-paths-view-' + view.id);
      if (container) showViewFailure(view, container, 'activated');
    }
  }
}
