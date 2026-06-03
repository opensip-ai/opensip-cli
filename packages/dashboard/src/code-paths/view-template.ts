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
  const queryVar = `__rankedSearchQuery_${config.id.replaceAll(/\W/g, '_')}`;
  const searchStateDecl = searchByName ? `let ${queryVar} = '';\n` : '';
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
    container.appendChild(searchInput);`
    : '';
  const resultsHostDecl = searchByName
    ? `    const rowsHost = el('div'); container.appendChild(rowsHost);`
    : `    const rowsHost = container;`;
  // Substring filter on simpleName; empty query keeps everything.
  const searchFilterExpr = searchByName
    ? String.raw`(function(occ){
        const q = (${queryVar} || '').trim().toLowerCase();
        if (q.length === 0) return true;
        const nm = (occ.simpleName || '').toLowerCase();
        return nm.indexOf(q) !== -1;
      })`
    : '(function(){ return true; })';
  const onActivateBlock = searchByName
    ? String.raw`,
  onActivate() {
    const input = document.getElementById('code-paths-search-${config.id}');
    if (input && typeof input.focus === 'function') input.focus();
  }`
    : '';
  return String.raw`
${searchStateDecl}views.push({
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
${searchInputBlock}
${resultsHostDecl}
    const __searchFilter = ${searchFilterExpr};
    function renderRows() {
      const filtered = ranked.filter(r => __searchFilter(r.occ));
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
