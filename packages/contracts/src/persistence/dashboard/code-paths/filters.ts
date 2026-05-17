/**
 * Filter state + collapsible Filters drawer for the Code Paths panel.
 *
 * Singleton `filterState` with three dimensions:
 *   - packages: Set<string>  — empty means "all packages allowed"
 *   - kinds:    Set<string>  — empty means "all kinds allowed"
 *   - includeTests: boolean  — defaults to false (production-only)
 *
 * `renderFilterChips(container, catalog)` mounts a "Filters ▾" toggle
 * showing the active count, plus a body (hidden by default) that
 * groups the controls under labeled rows: Package, Kind, Scope.
 * Toggling chips updates filterState and calls notifyViews()
 * (Observer — §10.3).
 *
 * `passesFilter(occ, filterState)` is the per-row predicate every view
 * uses; per-view specialization stacks on top.
 */

export function dashboardFiltersJs(): string {
  return String.raw`
const filterState = {
  packages: new Set(),
  kinds: new Set(),
  includeTests: false,
  __open: false,
};

const KIND_LIST = ['function-declaration', 'function-expression', 'method', 'arrow', 'constructor', 'getter', 'setter', 'module-init'];

function packagesInCatalog(catalog) {
  const pkgs = new Set();
  if (!catalog || !catalog.functions) return [];
  for (const name of Object.keys(catalog.functions)) {
    for (const occ of (catalog.functions[name] || [])) {
      pkgs.add(packageOfPath(occ.filePath));
    }
  }
  return Array.from(pkgs).sort();
}

function passesFilter(occ, fs) {
  if (!fs.includeTests && occ.inTestFile) return false;
  if (fs.packages.size > 0 && !fs.packages.has(packageOfPath(occ.filePath))) return false;
  if (fs.kinds.size > 0 && !fs.kinds.has(occ.kind)) return false;
  return true;
}

function activeFilterCount() {
  return filterState.packages.size + filterState.kinds.size + (filterState.includeTests ? 1 : 0);
}

function clearFilters() {
  filterState.packages.clear();
  filterState.kinds.clear();
  filterState.includeTests = false;
}

function renderFilterChips(container, catalog) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  function makeChip(label, isActive, onclick) {
    return el('span', {
      class: 'code-paths-chip' + (isActive ? ' active' : ''),
      text: label,
      onclick,
    });
  }

  // Header row — toggle button, active count, clear-all.
  const header = el('div', { class: 'code-paths-filter-header' });
  const count = activeFilterCount();
  const toggle = el('button', {
    class: 'code-paths-filter-toggle' + (filterState.__open ? ' open' : ''),
    'aria-expanded': filterState.__open ? 'true' : 'false',
    text: 'Filters ' + (filterState.__open ? '▾' : '▸'),
    onclick: () => {
      filterState.__open = !filterState.__open;
      renderFilterChips(container, catalog);
    },
  });
  header.appendChild(toggle);
  const countLabel = el('span', {
    class: 'code-paths-filter-count' + (count > 0 ? ' active' : ''),
    text: count === 0 ? 'none active' : count + ' active',
  });
  header.appendChild(countLabel);
  if (count > 0) {
    const clearBtn = el('button', {
      class: 'code-paths-filter-clear',
      text: 'Clear',
      onclick: () => {
        clearFilters();
        renderFilterChips(container, catalog);
        notifyViews();
      },
    });
    header.appendChild(clearBtn);
  }
  container.appendChild(header);

  if (!filterState.__open) return;

  // Body — labeled rows for Package, Kind, Scope.
  const body = el('div', { class: 'code-paths-filter-body' });

  function makeRow(labelText, controls) {
    const row = el('div', { class: 'code-paths-filter-row' });
    row.appendChild(el('div', { class: 'code-paths-filter-label', text: labelText }));
    const chipWrap = el('div', { class: 'code-paths-filter-chips-wrap' });
    for (const c of controls) chipWrap.appendChild(c);
    row.appendChild(chipWrap);
    return row;
  }

  const pkgChips = packagesInCatalog(catalog).map(pkg => makeChip(pkg, filterState.packages.has(pkg), () => {
    if (filterState.packages.has(pkg)) filterState.packages.delete(pkg);
    else filterState.packages.add(pkg);
    renderFilterChips(container, catalog);
    notifyViews();
  }));
  body.appendChild(makeRow('Package', pkgChips));

  const kindChips = KIND_LIST.map(kind => makeChip(kind, filterState.kinds.has(kind), () => {
    if (filterState.kinds.has(kind)) filterState.kinds.delete(kind);
    else filterState.kinds.add(kind);
    renderFilterChips(container, catalog);
    notifyViews();
  }));
  body.appendChild(makeRow('Kind', kindChips));

  const scopeRadios = el('div', { class: 'code-paths-filter-scope' });
  function makeRadio(label, isActive, onclick) {
    const r = el('label', { class: 'code-paths-filter-radio' + (isActive ? ' active' : '') });
    const dot = el('span', { class: 'code-paths-filter-radio-dot' + (isActive ? ' active' : '') });
    r.appendChild(dot);
    r.appendChild(document.createTextNode(' ' + label));
    r.addEventListener('click', onclick);
    return r;
  }
  scopeRadios.appendChild(makeRadio('Production only', !filterState.includeTests, () => {
    if (filterState.includeTests) {
      filterState.includeTests = false;
      renderFilterChips(container, catalog);
      notifyViews();
    }
  }));
  scopeRadios.appendChild(makeRadio('Include tests', filterState.includeTests, () => {
    if (!filterState.includeTests) {
      filterState.includeTests = true;
      renderFilterChips(container, catalog);
      notifyViews();
    }
  }));
  body.appendChild(makeRow('Scope', [scopeRadios]));

  container.appendChild(body);
}

function notifyViews() {
  // Per §10.3 the Observer dispatch fans out to every registered view in
  // registration order, regardless of which one is active. Hidden views
  // re-render into their own (display:none) container; the cost is small
  // because the row-table renderers are O(rows) and tables are bounded
  // (top 50 / 30 / 20 etc.).
  for (const view of views) {
    const container = document.getElementById('code-paths-view-' + view.id);
    if (!container) continue;
    view.render(container, graphCatalog, graphIndexes, filterState);
  }
}
`;
}
