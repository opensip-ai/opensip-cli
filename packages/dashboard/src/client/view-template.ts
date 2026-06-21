/**
 * `defineRankedView` — the rank-and-render skeleton for ranked-list views.
 *
 * Ranked views (the Functions/distribution view today) share one shape:
 *
 *   1. Bail out with an empty-state message if the catalog is missing.
 *   2. Walk `indexes.byBodyHash.values()`, applying the active filter chips
 *      (`passesFilter`) and an optional view-specific predicate.
 *   3. Compute a per-occurrence numeric metric (returning `false` skips a row).
 *   4. Sort descending by that metric.
 *   5. Render via `renderFunctionRows` with the supplied columns, or show an
 *      empty-state if everything was filtered out.
 *
 * Optionally renders a controls row above the table: a Kind single-select, a
 * Package single-select, a name-search input, and a checkbox toggle. Each
 * re-filters the rendered rows in place.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib). It used to splice JS-source expression strings into an
 * emitted view; now it takes real functions and pushes the View directly into
 * the shared `views` registry. esbuild bundles it into the inlined client
 * `<script>`.
 */

import { el } from './el.js';
import { passesFilter, KIND_LIST, packagesInCatalog } from './filters.js';
import { makeSectionHeading, renderFunctionRows, type RowColumn } from './function-row.js';
import { pkgOf } from './path-utils.js';
import { views } from './views-registry.js';

import type { CatalogLike, FilterStateLike, IndexesLike, OccLike } from './code-paths-types.js';

/** An occurrence augmented with the ranking metric (and any row extras). */
type RankedOcc = OccLike & { __metric: number };

/** Help-drawer copy for a ranked view. */
interface RankedViewHelp {
  title: string;
  sections: { heading: string; body: string }[];
}

export interface RankedViewConfig {
  /** Stable id (e.g. `'distribution'`). Must match the existing tab id. */
  id: string;
  /** Tab label. */
  label: string;
  /** Help-drawer copy. */
  help: RankedViewHelp;
  /**
   * The ranking metric for one occurrence. Closes over the in-page `indexes`.
   * Normally a non-negative number — rows sort by `b.metric - a.metric` so
   * larger values rank higher. Returning `false` SKIPS the row entirely.
   */
  metric: (occ: OccLike, indexes: IndexesLike) => number | false;
  /**
   * Optional row predicate. Truthy = keep; falsy = skip. Defaults to
   * `passesFilter(occ, filterState)`. When supplied it REPLACES the default, so
   * include `passesFilter(...)` yourself if you still want chip filtering.
   */
  predicate?: (occ: OccLike, filterState: FilterStateLike) => boolean;
  /**
   * Optional extra fields merged onto each rendered row via Object.assign.
   * Defaults to `{}`. Closes over the occurrence and its metric.
   */
  rowExtras?: (occ: OccLike, metric: number) => Record<string, unknown>;
  /** Columns rendered by `renderFunctionRows`. */
  columns: RowColumn[];
  /** Section heading text (e.g. "Functions"). */
  headingText: string;
  /** Empty-state message when the filter strips everything. */
  emptyMessage: string;
  /**
   * When true, render a search input above the table that filters the ranked
   * rows by function simple-name (case-insensitive substring), and auto-focus
   * it when the view activates.
   */
  searchByName?: boolean;
  /**
   * When true, render a Kind single-select and a Package single-select dropdown
   * alongside the search box (Kind, Package, then the search box).
   */
  filterByKindPackage?: boolean;
  /**
   * When set, render a checkbox toggle AFTER the search box that narrows the
   * table to rows matching `predicate` when checked (off by default).
   */
  filterToggle?: { label: string; predicate: (occ: OccLike) => boolean };
}

/**
 * Register a ranked view into the shared `views` registry. The metric /
 * predicate / column callbacks run at render time over the in-page `indexes`
 * and `filterState` — the same locals the legacy emitter spliced JS source
 * against.
 */
export function defineRankedView(config: RankedViewConfig): void {
  const predicate = config.predicate ?? ((occ, filterState) => passesFilter(occ, filterState));
  const rowExtras = config.rowExtras ?? (() => ({}));
  const searchByName = config.searchByName === true;
  const filterByKP = config.filterByKindPackage === true;
  const toggle = config.filterToggle ?? null;
  const hasControls = searchByName || filterByKP || toggle !== null;

  // Per-view filter state (a closure object, namespaced per registration so
  // multiple ranked views coexist without clobbering each other).
  const state = { query: '', kind: '', pkg: '', toggleOn: false };

  // Combined row predicate: Kind, Package, then name substring, then toggle.
  // Each clause is skipped when its control is absent or set to "all"/empty. A
  // boolean predicate — a `false` return means "filter this row out", not an
  // error path (the `should…` name marks it as a predicate, not a guard).
  function shouldShowRow(occ: OccLike): boolean {
    if (filterByKP && state.kind && occ.kind !== state.kind) return false;
    if (filterByKP && state.pkg && pkgOf(occ) !== state.pkg) return false;
    const q = searchByName ? state.query.trim().toLowerCase() : '';
    if (q.length > 0 && !(occ.simpleName ?? '').toLowerCase().includes(q)) return false;
    return !(toggle && state.toggleOn && !toggle.predicate(occ));
  }

  // Build the Kind + Package single-selects (filterByKindPackage). Options come
  // from the shared KIND_LIST / packagesInCatalog.
  function buildKindPackage(
    controlsRow: HTMLElement,
    catalog: CatalogLike,
    onChange: () => void,
  ): void {
    controlsRow.append(el('span', { class: 'code-paths-graph-toolbar-label', text: 'Kind' }));
    const fnKindSel = el('select', {
      class: 'code-paths-graph-select',
      'data-control': 'fn-kind',
    }) as HTMLSelectElement;
    fnKindSel.append(el('option', { value: '', text: 'All kinds' }));
    for (const k of KIND_LIST) {
      const o = el('option', { value: k, text: k }) as HTMLOptionElement;
      if (k === state.kind) o.selected = true;
      fnKindSel.append(o);
    }
    fnKindSel.addEventListener('change', (e) => {
      state.kind = (e.target as HTMLSelectElement).value || '';
      onChange();
    });
    controlsRow.append(fnKindSel);
    controlsRow.append(el('span', { class: 'code-paths-graph-toolbar-label', text: 'Package' }));
    const fnPkgSel = el('select', {
      class: 'code-paths-graph-select',
      'data-control': 'fn-package',
    }) as HTMLSelectElement;
    fnPkgSel.append(el('option', { value: '', text: 'All packages' }));
    for (const p of packagesInCatalog(catalog)) {
      const o = el('option', { value: p, text: p }) as HTMLOptionElement;
      if (p === state.pkg) o.selected = true;
      fnPkgSel.append(o);
    }
    fnPkgSel.addEventListener('change', (e) => {
      state.pkg = (e.target as HTMLSelectElement).value || '';
      onChange();
    });
    controlsRow.append(fnPkgSel);
  }

  // Build the search input — re-filters by simple-name substring in place.
  function buildSearchInput(controlsRow: HTMLElement, onChange: () => void): void {
    const searchInput = el('input', {
      type: 'search',
      class: 'search-input code-paths-search',
      id: 'code-paths-search-' + config.id,
      placeholder: 'Filter functions by name…',
    }) as HTMLInputElement;
    searchInput.value = state.query;
    searchInput.addEventListener('input', (e) => {
      state.query = (e.target as HTMLInputElement).value || '';
      onChange();
    });
    controlsRow.append(searchInput);
  }

  // Build the checkbox toggle (filterToggle) — rendered AFTER the search box.
  function buildToggle(controlsRow: HTMLElement, t: { label: string }, onChange: () => void): void {
    const toggleLabel = el('label', { class: 'code-paths-graph-checkbox' });
    const toggleCb = el('input', {
      type: 'checkbox',
      'data-control': 'fn-toggle',
    }) as HTMLInputElement;
    toggleCb.checked = state.toggleOn;
    toggleCb.addEventListener('change', () => {
      state.toggleOn = toggleCb.checked;
      onChange();
    });
    toggleLabel.append(toggleCb);
    toggleLabel.append(' ' + t.label);
    controlsRow.append(toggleLabel);
  }

  views.push({
    id: config.id,
    label: config.label,
    help: config.help,
    render(container, catalog, indexes, filterState) {
      while (container.firstChild) container.firstChild.remove();
      if (!catalog?.functions) {
        container.append(el('div', { class: 'empty', text: 'No catalog loaded.' }));
        return;
      }
      const ranked: { occ: OccLike; metric: number }[] = [];
      for (const occ of indexes.byBodyHash.values()) {
        if (!predicate(occ, filterState)) continue;
        const metric = config.metric(occ, indexes);
        if (metric === false) continue;
        ranked.push({ occ, metric });
      }
      ranked.sort((a, b) => b.metric - a.metric);
      if (ranked.length === 0) {
        container.append(el('div', { class: 'empty', text: config.emptyMessage }));
        return;
      }

      // The section heading renders into its OWN host ABOVE the controls (so the
      // "Functions (N) ⓘ" heading sits above the dropdowns, consistent with the
      // Coupling and Visualization views). The rows always render into a
      // separate host below — renderFunctionRows clears its host, so it must NOT
      // be the shared container (that would wipe the heading + controls).
      const headingHost = el('div');
      container.append(headingHost);

      const rowsHost = el('div');

      function renderRows(): void {
        const filtered = ranked.filter((r) => shouldShowRow(r.occ));
        // Heading (with the ⓘ help button) above the controls; its count tracks
        // the currently-shown rows as the filters narrow them.
        while (headingHost.firstChild) headingHost.firstChild.remove();
        headingHost.append(
          makeSectionHeading(config.headingText + ' (' + filtered.length + ')', config.id),
        );
        if (filtered.length === 0) {
          while (rowsHost.firstChild) rowsHost.firstChild.remove();
          rowsHost.append(el('div', { class: 'empty', text: config.emptyMessage }));
          return;
        }
        renderFunctionRows(rowsHost, {
          occurrences: filtered.map(
            (r): RankedOcc => ({ ...r.occ, __metric: r.metric, ...rowExtras(r.occ, r.metric) }),
          ),
          columns: config.columns,
          heading: config.headingText,
          viewId: config.id,
          skipHeading: true,
        });
      }

      if (hasControls) {
        const controlsRow = el('div', { class: 'code-paths-ranked-controls' });
        if (filterByKP) buildKindPackage(controlsRow, catalog, renderRows);
        if (searchByName) buildSearchInput(controlsRow, renderRows);
        if (toggle) buildToggle(controlsRow, toggle, renderRows);
        container.append(controlsRow);
      }

      container.append(rowsHost);
      renderRows();
    },
    onActivate: searchByName
      ? () => {
          const input = document.querySelector('#code-paths-search-' + config.id);
          if (input instanceof HTMLInputElement && typeof input.focus === 'function') input.focus();
        }
      : undefined,
  });
}
