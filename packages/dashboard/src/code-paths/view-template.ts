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

export interface RankedViewColumn {
  /** Header label (e.g. "Function", "Callers"). */
  label: string;
  /**
   * JS source for the cell value. Receives the augmented occurrence
   * `o` (the original `occ` plus a `__metric` field with the ranking
   * value, plus any extras the view spliced into the row map). For
   * example: `o => displayName(o.simpleName)`.
   */
  value: string;
}

export interface RankedViewHelpSection {
  heading: string;
  body: string;
}

export interface RankedViewHelp {
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
   * JS source for the metric expression. Closes over `occ` (the
   * occurrence). Example: `(indexes.callers.get(occ.bodyHash) || []).length`.
   */
  metric: string;
  /**
   * Optional JS source for a predicate expression. Closes over `occ`
   * and `filterState`. Truthy = keep; falsy = skip. Defaults to
   * `passesFilter(occ, filterState)`. When a predicate is supplied it
   * REPLACES the default `passesFilter` call entirely — pass it as
   * part of the predicate when you still want chip filtering.
   */
  predicate?: string;
  /**
   * Optional JS source emitting extra fields to splice into the row
   * via `Object.assign`. Closes over `occ` and `metric`. Defaults to
   * `{}`. Used by Wide to splice in a `__thumb` parameter list.
   */
  rowExtras?: string;
  /**
   * Optional JS source for additional helper declarations to emit
   * inside the `render` body, before the metric loop. Used by Wide
   * for the `paramThumb` helper.
   */
  preamble?: string;
  /** Columns rendered by `renderFunctionRows`. */
  columns: RankedViewColumn[];
  /** Section heading text (e.g. "Big functions"). */
  headingText: string;
  /** Empty-state message when the filter strips everything. */
  emptyMessage: string;
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
  return String.raw`
views.push({
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
    renderFunctionRows(
      container,
      ranked.map(r => Object.assign({}, r.occ, { __metric: r.metric }, (function(occ, metric){ return ${rowExtras}; })(r.occ, r.metric))),
      [
${columnsLiteral}
      ],
      ${jsString(config.headingText)},
      ${jsString(config.id)},
    );
  },
});
`;
}
