/**
 * Checks catalog rendering — browsable catalog of checks with run stats.
 *
 * `renderChecksCatalog(container, catalogData)` renders a filterable, paginated
 * table of checks (search + tag + source filters) into any panel. Run stats
 * (runs / pass rate / last run) are derived from the inlined `sessions` payloads.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 * `renderChecksCatalog` stays exposed as a page global because the still-string-
 * emitted Code Paths panel can reach for it by bare name.
 */

import { el } from './el.js';
import { paginateGroupedRows, renderPageButtons } from './pagination.js';

/** A check catalog entry (tool domain vocabulary, read structurally). */
interface CheckEntry {
  slug: string;
  name: string;
  source: string;
  confidence: string;
  tags?: string[];
  longDescription?: string;
}

/** Aggregated run stats for one check, derived from the session payloads. */
interface CheckStat {
  runs: number;
  passed: number;
  failed: number;
  lastRun: string | null;
}

const DIM = 'color:var(--text-dim)';
const EM_DASH = '—';
const EXPANDER_ROW = 'expander-row';
const PAGE_SIZE = 10;
const EMPTY_STAT: CheckStat = { runs: 0, passed: 0, failed: 0, lastRun: null };

/** Pass-rate band color for a rate in [0, 100]. */
function rateColorFor(rate: number): string {
  if (rate >= 90) return 'var(--success)';
  if (rate >= 70) return 'var(--warning)';
  return 'var(--error)';
}

/** Render one page of the filtered group set into `pag` (info line + page buttons). */
function renderFilteredPage(
  pag: HTMLElement,
  groups: HTMLElement[][],
  currentPage: number,
  totalPages: number,
): void {
  // Hide all filtered rows first, then reveal only the current page's data rows.
  groups.forEach((g) => g.forEach((r) => (r.style.display = 'none')));
  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  groups.slice(start, end).forEach((g) => (g[0].style.display = ''));

  while (pag.firstChild) pag.firstChild.remove();
  if (groups.length <= PAGE_SIZE) return;
  pag.append(
    el('div', {
      class: 'pagination-info',
      text:
        'Showing ' +
        (start + 1) +
        '-' +
        Math.min(end, groups.length) +
        ' of ' +
        groups.length +
        ' checks',
    }),
  );
  const btns = el('div', { class: 'pagination-btns' });
  renderPageButtons(btns, currentPage, totalPages, (p) =>
    renderFilteredPage(pag, groups, p, totalPages),
  );
  pag.append(btns);
}

/** Custom paginator for the filtered subset (only matching groups). */
function paginateFilteredGroups(pag: HTMLElement, groups: HTMLElement[][]): void {
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  renderFilteredPage(pag, groups, 0, totalPages);
}

function computeCheckStats(): Record<string, CheckStat> {
  const stats: Record<string, CheckStat> = {};
  for (const s of sessions) {
    // Per-session detail lives in the tool-owned opaque payload; fitness
    // sessions carry { summary, checks }. Sessions without checks (graph, sim)
    // contribute nothing here.
    const checks =
      (s.payload?.checks as { checkSlug: string; passed?: boolean }[] | undefined) ?? [];
    for (const ch of checks) {
      stats[ch.checkSlug] ??= { runs: 0, passed: 0, failed: 0, lastRun: null };
      const st = stats[ch.checkSlug];
      st.runs++;
      if (ch.passed) st.passed++;
      else st.failed++;
      if (!st.lastRun || s.startedAt > st.lastRun) st.lastRun = s.startedAt;
    }
  }
  return stats;
}
const checkStats = computeCheckStats();

/** Render longDescription as DOM nodes with bold and code formatting. Safe — no innerHTML. */
function renderLongDesc(text: string | undefined): HTMLElement {
  const container = document.createElement('div');
  container.className = 'check-long-desc';
  if (!text) return container;
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\n)/g);
  parts.forEach((part) => {
    if (part === '\n') {
      container.append(document.createElement('br'));
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      container.append(strong);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      container.append(code);
    } else {
      container.append(part);
    }
  });
  return container;
}

/** Build the filter bar (search input + tag/source selects). */
function buildFilterBar(sortedTags: string[]): {
  filterBar: HTMLElement;
  searchInput: HTMLInputElement;
  tagSelect: HTMLSelectElement;
  sourceSelect: HTMLSelectElement;
} {
  const filterBar = el('div', { class: 'filter-bar' });
  const searchInput = el('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Search checks...',
  }) as HTMLInputElement;
  const tagSelect = el('select', { class: 'filter-select' }) as HTMLSelectElement;
  tagSelect.append(el('option', { value: '', text: 'All tags' }));
  sortedTags.forEach((t) => tagSelect.append(el('option', { value: t, text: t })));
  const sourceSelect = el('select', { class: 'filter-select' }) as HTMLSelectElement;
  ['', 'built-in', 'community'].forEach((v) => {
    sourceSelect.append(el('option', { value: v, text: v || 'All sources' }));
  });
  filterBar.append(searchInput);
  filterBar.append(tagSelect);
  filterBar.append(sourceSelect);
  return { filterBar, searchInput, tagSelect, sourceSelect };
}

/** Build the pass-rate bar cell content for a rate in [0, 100], or em-dash for < 0. */
function buildRateCell(rate: number): HTMLElement {
  const rateCell = el('td');
  if (rate >= 0) {
    const rateColor = rateColorFor(rate);
    const bar = el('span', { class: 'pass-rate-bar' });
    const track = el('span', { class: 'pass-rate-track' });
    track.append(
      el('span', { class: 'pass-rate-fill', style: 'width:' + rate + '%;background:' + rateColor }),
    );
    bar.append(track);
    bar.append(el('span', { text: rate + '%', style: 'font-size:12px;color:' + rateColor }));
    rateCell.append(bar);
  } else {
    rateCell.textContent = EM_DASH;
    rateCell.style.color = 'var(--text-dim)';
  }
  return rateCell;
}

/** Build one catalog data row (+ its expander row when it has a long description). */
function buildCheckRow(check: CheckEntry, i: number, uid: string): HTMLElement[] {
  const st = checkStats[check.slug] ?? EMPTY_STAT;
  const rate = st.runs > 0 ? Math.round((st.passed / st.runs) * 100) : -1;
  const hasDesc = !!check.longDescription;
  const expanderId = uid + '-exp-' + i;
  const tags = check.tags ?? [];

  const arrowCell = el('td', {
    style: 'width:24px;text-align:center;' + DIM + ';font-size:12px',
  });
  if (hasDesc) arrowCell.textContent = '▶';

  const row = el('tr', {
    class: hasDesc ? 'clickable' : '',
    'data-slug': check.slug,
    'data-tags': tags.join(','),
    'data-source': check.source,
    'data-name': check.name.toLowerCase(),
    onclick: hasDesc
      ? () => {
          const exp = document.querySelector<HTMLElement>('#' + expanderId);
          if (exp) {
            const isOpen = exp.classList.toggle('open');
            exp.style.display = isOpen ? 'table-row' : 'none';
            arrowCell.textContent = isOpen ? '▼' : '▶';
          }
          row.classList.toggle('expanded');
        }
      : undefined,
  });
  row.append(arrowCell);

  const nameCell = el('td', { style: 'font-weight:500' });
  nameCell.append(check.slug);
  row.append(nameCell);

  const tagsCell = el('td');
  tags.slice(0, 4).forEach((t) => {
    tagsCell.append(el('span', { class: 'tag-badge', text: t }));
  });
  if (tags.length > 4) {
    tagsCell.append(el('span', { class: 'tag-badge', text: '+' + (tags.length - 4) }));
  }
  row.append(tagsCell);

  const confCell = el('td');
  confCell.append(el('span', { class: 'badge badge-' + check.confidence, text: check.confidence }));
  row.append(confCell);

  const sourceCell = el('td');
  const sourceStyle =
    check.source === 'built-in' ? 'color:var(--accent)' : 'color:var(--accent-sim)';
  sourceCell.append(el('span', { text: check.source, style: sourceStyle + ';font-size:12px' }));
  row.append(sourceCell);

  row.append(el('td', { text: st.runs > 0 ? '' + st.runs : EM_DASH, style: DIM }));
  row.append(buildRateCell(rate));
  row.append(
    el('td', {
      text: st.lastRun ? new Date(st.lastRun).toLocaleDateString() : EM_DASH,
      style: DIM + ';font-size:12px',
    }),
  );

  const rows = [row];
  if (hasDesc) {
    const expRow = el('tr', {
      id: expanderId,
      class: EXPANDER_ROW,
      'data-slug': check.slug,
      'data-tags': tags.join(','),
      'data-source': check.source,
      'data-name': check.name.toLowerCase(),
    });
    const expCell = el('td', { colspan: '8', style: 'padding:0' });
    const expContent = el('div', { class: 'expander-content' });
    expContent.append(renderLongDesc(check.longDescription));
    expCell.append(expContent);
    expRow.append(expCell);
    rows.push(expRow);
  }
  return rows;
}

export function renderChecksCatalog(panel: HTMLElement, catalogData: readonly unknown[]): void {
  const entries = catalogData as readonly CheckEntry[];
  if (entries.length === 0) {
    panel.append(el('div', { class: 'empty', text: 'No checks registered.' }));
    return;
  }

  const allTags = new Set<string>();
  entries.forEach((c) => (c.tags ?? []).forEach((t) => allTags.add(t)));
  const sortedTags = [...allTags].sort();

  const { filterBar, searchInput, tagSelect, sourceSelect } = buildFilterBar(sortedTags);
  panel.append(filterBar);

  // Stats summary.
  const totalChecks = entries.length;
  const builtinCount = entries.filter((c) => c.source === 'built-in').length;
  const communityCount = entries.filter((c) => c.source === 'community').length;
  const statsRow = el('div', {
    style: 'display:flex;gap:16px;margin-bottom:16px;font-size:13px;color:var(--text-muted)',
  });
  statsRow.append(el('span', { text: totalChecks + ' total checks' }));
  statsRow.append(el('span', { text: builtinCount + ' built-in', style: 'color:var(--accent)' }));
  if (communityCount > 0)
    statsRow.append(
      el('span', { text: communityCount + ' community', style: 'color:var(--accent-sim)' }),
    );
  panel.append(statsRow);

  // Table.
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['', 'Check', 'Tags', 'Confidence', 'Source', 'Runs', 'Pass Rate', 'Last Run'].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  const sorted = [...entries].sort((a, b) => a.slug.localeCompare(b.slug));
  const uid = 'cc-' + Math.random().toString(36).slice(2, 8);

  sorted.forEach((check, i) => {
    buildCheckRow(check, i, uid).forEach((r) => tbody.append(r));
  });

  table.append(tbody);
  const pag = el('div', { class: 'pagination' });
  const card = el('div', { class: 'card' }, [table, pag]);
  panel.append(card);

  const emptyMsg = el('div', {
    class: 'empty',
    style: 'display:none',
    text: 'No checks match your filters.',
  });
  pag.before(emptyMsg);
  paginateGroupedRows(tbody, pag, 10);

  // Tracks which data rows pass the current filter without stamping a
  // non-standard property onto the DOM node (the legacy code used `row._filterVisible`).
  const filterVisible = new WeakMap<HTMLElement, boolean>();

  /** Does a data row match the current search / tag / source filters? */
  function rowMatchesFilters(row: HTMLElement): boolean {
    const search = searchInput.value.toLowerCase();
    const tag = tagSelect.value;
    const source = sourceSelect.value;
    const slug = row.dataset.slug ?? '';
    const name = row.dataset.name ?? '';
    const rowTags = row.dataset.tags ?? '';
    const rowSource = row.dataset.source ?? '';
    const matchSearch = !search || slug.includes(search) || name.includes(search);
    const matchTag = !tag || rowTags.split(',').includes(tag);
    const matchSource = !source || rowSource === source;
    return matchSearch && matchTag && matchSource;
  }

  /** Collapse a data row's trailing expander row (if any) back to its closed state. */
  function collapseExpander(row: HTMLElement, next: HTMLElement | undefined): void {
    if (!next?.classList.contains(EXPANDER_ROW)) return;
    next.style.display = 'none';
    next.classList.remove('open');
    if (!row.classList.contains('expanded')) return;
    row.classList.remove('expanded');
    const arrowTd = row.firstElementChild as HTMLElement | null;
    if (arrowTd) arrowTd.textContent = '▶';
  }

  /** First pass: mark each data row visible/hidden, collapse its expander. */
  function markRowVisibility(allRows: HTMLElement[]): number {
    let visibleCount = 0;
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      if (row.classList.contains(EXPANDER_ROW)) continue;
      const visible = rowMatchesFilters(row);
      row.style.display = visible ? '' : 'none';
      filterVisible.set(row, visible);
      if (visible) visibleCount++;
      collapseExpander(row, allRows[i + 1]);
    }
    return visibleCount;
  }

  /** Collect the visible groups (data row + optional trailing expander). */
  function collectVisibleGroups(allRows: HTMLElement[]): HTMLElement[][] {
    const groups: HTMLElement[][] = [];
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      if (row.classList.contains(EXPANDER_ROW)) continue;
      if (!filterVisible.get(row)) continue;
      const group = [row];
      const next = allRows[i + 1];
      if (next?.classList.contains(EXPANDER_ROW)) group.push(next);
      groups.push(group);
    }
    return groups;
  }

  function applyFilters(): void {
    const allRows = [...tbody.children] as HTMLElement[];
    const visibleCount = markRowVisibility(allRows);
    emptyMsg.style.display = visibleCount === 0 ? '' : 'none';

    const hasFilters = searchInput.value || tagSelect.value || sourceSelect.value;
    if (hasFilters) {
      paginateFilteredGroups(pag, collectVisibleGroups(allRows));
    } else {
      paginateGroupedRows(tbody, pag, 10);
    }
  }

  searchInput.addEventListener('input', applyFilters);
  tagSelect.addEventListener('change', applyFilters);
  sourceSelect.addEventListener('change', applyFilters);
}
