/**
 * Contributed-tabs renderer (host-owned-run-timing Phase 5 §7.2).
 *
 * The GENERIC, data-driven renderer for per-run dashboard tabs that any tool
 * (first-party fit/sim/graph OR a third-party tool) contributes through the
 * `ToolDashboardContribution` seam. This package renders them WITHOUT importing
 * any tool package — it only knows the declarative `DashboardViewContribution`
 * union (`table` / `cards` / `timeline` / `chart` / `custom-html`) and reads the
 * inline row data the host resolved from the contribution's `dataKey`.
 *
 * Security (spec §7.2 / §12): self-contained reports are frequently shared
 * outside the machine that generated them, so a tool-supplied `custom-html` view
 * MUST NOT be injected as raw markup. At launch it is ESCAPED — rendered as
 * text inside a `<pre>` via the shared `el(...,{text})` helper (which sets
 * `textContent`, never `innerHTML`). Arbitrary plugin HTML/JS in a shared report
 * is deferred to a separate security decision (spec open decision §12). Every
 * other view kind likewise builds its DOM through `el()` (textContent-based), so
 * no contributed value reaches `innerHTML` anywhere in this module.
 */

/**
 * The resolved shape the generator inlines per contributed tab. `report-compose`
 * (the host) flattens each {@link ToolDashboardContribution} tab into this:
 * the namespaced DOM `id`, the `title`, the `order`, the declarative `view`, and
 * the `rows` it resolved from the contribution's `data[dataKey]` (always an
 * array; `cards` reads `rows[0]`). The dashboard package owns this contract so
 * it never imports the tool-facing core contribution types.
 */
export interface ContributedTab {
  /** Namespaced DOM id (e.g. `contrib-fit-fit-run-summary`). Host-namespaced. */
  readonly id: string;
  /** Tab button label / panel heading. */
  readonly title: string;
  /** Tab-bar order hint (lower first). */
  readonly order: number;
  /** The declarative view model (structurally mirrors core's union). */
  readonly view: ContributedView;
  /** Resolved inline rows for the view (from the contribution's dataKey). */
  readonly rows: readonly Record<string, unknown>[];
}

/** Structural mirror of core's `DashboardColumn` / `DashboardField`. */
interface ContributedFieldOrColumn {
  readonly key: string;
  readonly label: string;
  readonly format?: string;
}

/** Structural mirror of core's `DashboardChartSpec`. */
interface ContributedChartSpec {
  readonly kind: string;
  readonly xKey: string;
  readonly yKey: string;
  readonly title?: string;
}

/**
 * Structural mirror of core's `DashboardViewContribution` union. Declared here
 * (not imported from core) so the dashboard package keeps its zero-tool /
 * contracts-only dependency surface — it reads the shape structurally from the
 * inlined JSON.
 */
export type ContributedView =
  | { readonly kind: 'table'; readonly columns: readonly ContributedFieldOrColumn[] }
  | { readonly kind: 'cards'; readonly fields: readonly ContributedFieldOrColumn[] }
  | {
      readonly kind: 'timeline';
      readonly timeField: string;
      readonly fields: readonly ContributedFieldOrColumn[];
    }
  | { readonly kind: 'chart'; readonly chart: ContributedChartSpec }
  | { readonly kind: 'custom-html'; readonly html: string };

/**
 * Emit the browser-side JS that renders the inlined `contributedTabs`. Each tab
 * gets a `render_<id>()` function the generator calls; the body dispatches on
 * `tab.view.kind`. All DOM is built via `el()` (textContent), so every
 * tool-supplied string is escaped — including the `custom-html` body, which is
 * wrapped in a `<pre>` as text (no raw injection; see file header + spec §7.2).
 */
export function dashboardContributedTabsJs(): string {
  return String.raw`
// =======================================================
// CONTRIBUTED TABS (generic declarative renderer)
// =======================================================

// Format a single cell/field value per the declarative format hint. All
// outputs are plain strings handed to el({text}) (textContent), so no value is
// ever interpreted as markup.
function formatContributedValue(value, format) {
  if (value === null || value === undefined) return '';
  switch (format) {
    case 'boolean': return value ? 'yes' : 'no';
    case 'duration': {
      const n = Number(value);
      return Number.isFinite(n) ? n + ' ms' : String(value);
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? String(n) : String(value);
    }
    case 'date': return String(value);
    default: return String(value);
  }
}

function renderContributedTable(panel, columns, rows) {
  if (!rows || rows.length === 0) {
    panel.appendChild(el('div', { class: 'empty', text: 'No data for this run.' }));
    return;
  }
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headRow = el('tr');
  columns.forEach(function (c) { headRow.appendChild(el('th', { text: c.label })); });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach(function (row) {
    const tr = el('tr');
    columns.forEach(function (c) {
      tr.appendChild(el('td', { text: formatContributedValue(row[c.key], c.format) }));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(el('div', { class: 'card' }, [table]));
}

function renderContributedCards(panel, fields, rows) {
  const row = rows && rows.length > 0 ? rows[0] : null;
  if (!row) {
    panel.appendChild(el('div', { class: 'empty', text: 'No data for this run.' }));
    return;
  }
  // Reuse the existing .stat-grid / .stat-card shell (see css/cards.ts).
  const grid = el('div', { class: 'stat-grid' });
  fields.forEach(function (f) {
    const card = el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label', text: f.label }),
      el('div', { class: 'stat-value', text: formatContributedValue(row[f.key], f.format) }),
    ]);
    grid.appendChild(card);
  });
  panel.appendChild(grid);
}

function renderContributedTimeline(panel, timeField, fields, rows) {
  if (!rows || rows.length === 0) {
    panel.appendChild(el('div', { class: 'empty', text: 'No data for this run.' }));
    return;
  }
  const ordered = rows.slice().sort(function (a, b) {
    return String(a[timeField] || '').localeCompare(String(b[timeField] || ''));
  });
  const list = el('div', { class: 'timeline' });
  ordered.forEach(function (row) {
    const parts = fields.map(function (f) {
      return f.label + ': ' + formatContributedValue(row[f.key], f.format);
    });
    list.appendChild(el('div', { class: 'timeline-row' }, [
      el('span', { class: 'timeline-time', text: String(row[timeField] || '') }),
      el('span', { class: 'timeline-detail', text: parts.join('  ·  ') }),
    ]));
  });
  panel.appendChild(list);
}

// Minimal chart fallback: a labeled data table of (xKey, yKey) pairs. A richer
// inline chart can replace this without changing the contribution contract.
function renderContributedChart(panel, chart, rows) {
  if (chart && chart.title) panel.appendChild(el('div', { class: 'chart-title', text: chart.title }));
  renderContributedTable(panel, [
    { key: chart.xKey, label: chart.xKey, format: 'text' },
    { key: chart.yKey, label: chart.yKey, format: 'number' },
  ], rows);
}

// SECURITY: contributed custom-html is ESCAPED, not injected. We set it as
// textContent inside a <pre> (el({text}) → textContent), so a shared report can
// never execute tool-supplied markup/JS. See file header + spec §7.2 / §12.
function renderContributedCustomHtml(panel, html) {
  panel.appendChild(el('pre', { class: 'contributed-html', text: String(html || '') }));
}

function renderContributedTab(tab) {
  const panel = document.getElementById('panel-' + tab.id);
  if (!panel) return;
  panel.appendChild(el('h2', { class: 'panel-title', text: tab.title }));
  const view = tab.view || {};
  switch (view.kind) {
    case 'table': renderContributedTable(panel, view.columns || [], tab.rows || []); break;
    case 'cards': renderContributedCards(panel, view.fields || [], tab.rows || []); break;
    case 'timeline': renderContributedTimeline(panel, view.timeField, view.fields || [], tab.rows || []); break;
    case 'chart': renderContributedChart(panel, view.chart || {}, tab.rows || []); break;
    case 'custom-html': renderContributedCustomHtml(panel, view.html); break;
    default: panel.appendChild(el('div', { class: 'empty', text: 'Unsupported view.' }));
  }
}

function renderContributedTabs() {
  if (typeof contributedTabs === 'undefined' || !contributedTabs) return;
  contributedTabs.forEach(function (tab) { renderContributedTab(tab); });
}
`;
}
