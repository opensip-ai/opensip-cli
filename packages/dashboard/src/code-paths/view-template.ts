/**
 * `defineRankedView` — JS-string emitter for ranked-list views.
 *
 * Hot, Big, Wide, and Untested all share the same skeleton:
 *
 *   1. Bail out with an empty-state message if the catalog is missing.
 *   2. Walk `indexes.byBodyHash.values()`, applying the active filter
 *      chips (`passesFilter`) and an optional view-specific predicate.
 *   3. Compute a per-occurrence numeric metric.
 *   4. Sort descending by that metric.
 *   5. Render via `renderFunctionRows` with the supplied column
 *      definitions, or show an empty-state if everything was filtered
 *      out.
 *
 * This helper accepts a declarative config and emits the JS source for
 * one view. Each `view-*.ts` that fits the shape collapses to ~15 lines
 * of config; bespoke views (coupling, sccs, search) keep their own
 * emitters.
 *
 * The `metric` and `predicate` (and column `value`) fields are JS
 * source strings that close over the in-page locals `occ`, `o`,
 * `indexes`, `filterState`, etc. The helper splices them directly into
 * the emitted view; that is how the existing per-view emitters work
 * too. The skeleton is the only place that knows the rank-and-render
 * shape — adding a new ranked view means writing a config, not a new
 * `view-*.ts` file from scratch.
 */

interface RankedViewColumn {
  /** Header label (e.g. "Function", "Callers"). */
  label: string;
  /**
   * JS source for the cell value, spliced VERBATIM into the emitted
   * view body — there is no TS type-checking on this expression.
   *
   * Conventionally a single-arg arrow function `o => …`, where `o`
   * is the augmented occurrence: the original `occ` (graph function
   * descriptor) plus a `__metric` field carrying the ranking value
   * plus any extras the view's `rowExtras` returned (e.g. `__thumb`
   * in Wide). The expression closes over the in-page locals
   * `displayName` and `packageOfPath` (declared by `dashboardPathUtilsJs`)
   * and any helper the view's `preamble` declared.
   *
   * A typo here (`o => o.callerz`) compiles, lints, and ships — it
   * will fail at runtime as an undefined property read, not a build
   * error. Keep these expressions minimal and prefer pulling logic
   * into `preamble`-declared helpers when complexity grows.
   *
   * Example: `o => displayName(o.simpleName)`.
   */
  value: string;
}

interface RankedViewHelpSection {
  heading: string;
  body: string;
}

interface RankedViewHelp {
  title: string;
  sections: RankedViewHelpSection[];
}

export interface RankedViewConfig {
  /** Stable id (e.g. `'hot'`). Must match the existing tab id. */
  id: string;
  /** Tab label. */
  label: string;
  /** Help-drawer copy. */
  help: RankedViewHelp;
  /**
   * JS source for the metric expression, spliced VERBATIM into the
   * emitted view body — there is no TS type-checking on this
   * expression.
   *
   * Closes over `occ` (the graph function occurrence) and `indexes`
   * (the in-page indexes built by `buildIndexes`). The expression is
   * normally a non-negative number — `ranked.sort` uses `b.metric -
   * a.metric` so larger values rank higher.
   *
   * Sentinel: returning `false` skips the row entirely (used by Hot
   * and Wide to drop functions with zero callers / zero parameters
   * rather than rank them at zero). Returning any other falsy value
   * (`0`, `null`, `undefined`, `NaN`) does NOT skip — only literal
   * `false`. New views that want a "drop if predicate doesn't match"
   * filter should put it in `predicate` instead; the sentinel exists
   * because Hot and Wide want different drop conditions per call,
   * not a fixed predicate.
   *
   * Example: `(indexes.callers.get(occ.bodyHash) || []).length`.
   */
  metric: string;
  /**
   * Optional JS source for a predicate expression, spliced VERBATIM
   * into the emitted view body — there is no TS type-checking on
   * this expression.
   *
   * Closes over `occ` and `filterState`. Truthy = keep; falsy = skip.
   * Defaults to `passesFilter(occ, filterState)`. When a predicate
   * is supplied it REPLACES the default `passesFilter` call entirely
   * — include it in the predicate (e.g. `passesFilter(occ,
   * filterState) && occ.calls.length === 0`) when you still want
   * chip filtering.
   */
  predicate?: string;
  /**
   * Optional JS source emitting extra fields to splice into the row
   * via `Object.assign`, spliced VERBATIM into the emitted view body.
   * Closes over `occ` and `metric`. Defaults to `{}`. Used by Wide
   * to splice in a `__thumb` parameter list.
   */
  rowExtras?: string;
  /**
   * Optional JS source for additional helper declarations to emit
   * inside the `render` body, before the metric loop. Spliced
   * VERBATIM. Used by Wide for the `paramThumb` helper. Helpers
   * declared here are visible to `metric`, `predicate`, `rowExtras`,
   * and the column `value` expressions.
   */
  preamble?: string;
  /** Columns rendered by `renderFunctionRows`. */
  columns: RankedViewColumn[];
  /** Section heading text (e.g. "Big functions"). */
  headingText: string;
  /** Empty-state message when the filter strips everything. */
  emptyMessage: string;
  /**
   * When true, render a search input above the table that filters the
   * ranked rows by function simple-name (case-insensitive substring).
   * Typing re-filters the table in place; the search box auto-focuses
   * when the view activates. Used by the Functions view to absorb the
   * former standalone Search subtab.
   */
  searchByName?: boolean;
  /**
   * When true, render a Kind single-select and a Package single-select
   * dropdown alongside the search box (in one controls row above the table)
   * that further narrow the ranked rows. Both default to "all"; selecting a
   * value re-filters the table in place. Combines with `searchByName` (Kind,
   * Package, then the search box, in that order). Used by the Functions view.
   */
  filterByKindPackage?: boolean;
}

/**
 * Emit the JS source for a ranked view.
 *
 * The generated JS pushes a `View` literal into the `views` registry
 * already declared by `dashboardViewsRegistryJs`. The helper assumes
 * the standard set of in-page locals (`el`, `passesFilter`,
 * `displayName`, `packageOfPath`, `renderFunctionRows`) are available
 * — which they are, because `code-paths.ts` orders the emitters so
 * those declarations precede the view emitters.
 */
/**
 * Emit a JS source string literal in the project house style — single
 * quotes with `'` and `\\` escaped. Used so the generated views stay
 * byte-comparable to the hand-written ones they replace.
 */
function jsString(value: string): string {
  // Order matters — escape backslashes before quotes so the substituted
  // backslashes from quote-escaping aren't doubled.
  const BACKSLASH = String.fromCodePoint(92);
  const QUOTE = String.fromCodePoint(39);
  const escaped = value
    .split(BACKSLASH)
    .join(BACKSLASH + BACKSLASH)
    .split(QUOTE)
    .join(BACKSLASH + QUOTE);
  return QUOTE + escaped + QUOTE;
}

export function defineRankedView(config: RankedViewConfig): string {
  const helpJson = JSON.stringify(config.help);
  const columnsLiteral = config.columns
    .map(c => `        { label: ${jsString(c.label)}, value: ${c.value} }`)
    .join(',\n');
  const predicate = config.predicate ?? 'passesFilter(occ, filterState)';
  const rowExtras = config.rowExtras ?? '{}';
  const preamble = config.preamble ?? '';
  // When searchByName is on, the view keeps a module-scoped query string,
  // renders a search input above the table, and re-filters the ranked
  // rows by simple-name (case-insensitive substring) in place. The state
  // var is namespaced by view id so multiple search-enabled views can
  // coexist without clobbering each other.
  const searchByName = config.searchByName === true;
  const filterByKP = config.filterByKindPackage === true;
  const hasControls = searchByName || filterByKP;
  const idSuffix = config.id.replaceAll(/\W/g, '_');
  const queryVar = `__rankedSearchQuery_${idSuffix}`;
  const kindVar = `__rankedKind_${idSuffix}`;
  const pkgVar = `__rankedPkg_${idSuffix}`;
  const stateDecl =
    (searchByName ? `let ${queryVar} = '';\n` : '') +
    (filterByKP ? `let ${kindVar} = '';\nlet ${pkgVar} = '';\n` : '');
  // Kind + Package single-selects (filterByKindPackage). Built into the shared
  // controls row; each re-filters the table in place. Options come from the
  // shared KIND_LIST / packagesInCatalog (declared by the filters emitter).
  const kindPackageBlock = filterByKP
    ? String.raw`
    controlsRow.appendChild(el('span', { class: 'code-paths-graph-toolbar-label', text: 'Kind' }));
    const fnKindSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'fn-kind' });
    fnKindSel.appendChild(el('option', { value: '', text: 'All kinds' }));
    (typeof KIND_LIST !== 'undefined' ? KIND_LIST : []).forEach(function(k) {
      const o = el('option', { value: k, text: k });
      if (k === ${kindVar}) o.selected = true;
      fnKindSel.appendChild(o);
    });
    fnKindSel.addEventListener('change', e => { ${kindVar} = (e.target && e.target.value) || ''; renderRows(); });
    controlsRow.appendChild(fnKindSel);
    controlsRow.appendChild(el('span', { class: 'code-paths-graph-toolbar-label', text: 'Package' }));
    const fnPkgSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'fn-package' });
    fnPkgSel.appendChild(el('option', { value: '', text: 'All packages' }));
    ((typeof packagesInCatalog === 'function') ? packagesInCatalog(catalog) : []).forEach(function(p) {
      const o = el('option', { value: p, text: p });
      if (p === ${pkgVar}) o.selected = true;
      fnPkgSel.appendChild(o);
    });
    fnPkgSel.addEventListener('change', e => { ${pkgVar} = (e.target && e.target.value) || ''; renderRows(); });
    controlsRow.appendChild(fnPkgSel);`
    : '';
  const searchInputBlock = searchByName
    ? String.raw`
    const searchInput = el('input', {
      type: 'search',
      class: 'search-input code-paths-search',
      id: 'code-paths-search-${config.id}',
      placeholder: 'Filter functions by name…',
    });
    searchInput.value = ${queryVar};
    searchInput.addEventListener('input', e => {
      ${queryVar} = (e.target && e.target.value) || '';
      renderRows();
    });
    controlsRow.appendChild(searchInput);`
    : '';
  // The controls row (Kind · Package · search) sits above the table. When no
  // controls are configured, rows render straight into the container.
  const controlsBlock = hasControls
    ? String.raw`
    const controlsRow = el('div', { class: 'code-paths-ranked-controls' });${kindPackageBlock}${searchInputBlock}
    container.appendChild(controlsRow);`
    : '';
  const resultsHostDecl = hasControls
    ? `    const rowsHost = el('div'); container.appendChild(rowsHost);`
    : `    const rowsHost = container;`;
  // Combined row predicate: Kind, Package, then name substring. Each clause is
  // skipped when its control is absent or set to "all"/empty.
  const kindClause = filterByKP ? `if (${kindVar} && occ.kind !== ${kindVar}) return false;` : '';
  const pkgClause = filterByKP ? `if (${pkgVar} && pkgOf(occ) !== ${pkgVar}) return false;` : '';
  const nameClause = searchByName
    ? `const q = (${queryVar} || '').trim().toLowerCase(); if (q.length && (occ.simpleName || '').toLowerCase().indexOf(q) === -1) return false;`
    : '';
  const rowFilterExpr = hasControls
    ? `(function(occ){ ${kindClause} ${pkgClause} ${nameClause} return true; })`
    : '(function(){ return true; })';
  const onActivateBlock = searchByName
    ? String.raw`,
  onActivate() {
    const input = document.getElementById('code-paths-search-${config.id}');
    if (input && typeof input.focus === 'function') input.focus();
  }`
    : '';
  return String.raw`
${stateDecl}views.push({
  id: ${jsString(config.id)},
  label: ${jsString(config.label)},
  help: ${helpJson},
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    ${preamble}
    const ranked = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!(${predicate})) continue;
      const metric = (${config.metric});
      if (metric === false) continue;
      ranked.push({ occ, metric });
    }
    ranked.sort((a, b) => b.metric - a.metric);
    if (ranked.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: ${jsString(config.emptyMessage)} }));
      return;
    }
${controlsBlock}
${resultsHostDecl}
    const __rowFilter = ${rowFilterExpr};
    function renderRows() {
      const filtered = ranked.filter(r => __rowFilter(r.occ));
      if (filtered.length === 0) {
        while (rowsHost.firstChild) rowsHost.removeChild(rowsHost.firstChild);
        rowsHost.appendChild(el('div', { class: 'empty', text: ${jsString(config.emptyMessage)} }));
        return;
      }
      renderFunctionRows(
        rowsHost,
        filtered.map(r => Object.assign({}, r.occ, { __metric: r.metric }, (function(occ, metric){ return ${rowExtras}; })(r.occ, r.metric))),
        [
${columnsLiteral}
        ],
        ${jsString(config.headingText)},
        ${jsString(config.id)},
      );
    }
    renderRows();
  }${onActivateBlock}
});
`;
}
