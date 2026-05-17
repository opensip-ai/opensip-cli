/**
 * Filter chip state + chip rendering for the Code Paths panel.
 *
 * Singleton `filterState` with three dimensions:
 *   - packages: Set<string>  — empty means "all packages allowed"
 *   - kinds:    Set<string>  — empty means "all kinds allowed"
 *   - includeTests: boolean  — defaults to false (production-only)
 *
 * `renderFilterChips(container, catalog)` mounts the chip bar; chip
 * clicks toggle membership and call `notifyViews()` (Observer — §10.3).
 *
 * `passesFilter(occ, filterState)` is the per-row predicate every view
 * uses; it implements the per-view shape (§11.3 explicitly preserves
 * per-view specialization on top of this predicate).
 */

export function dashboardFiltersJs(): string {
  return String.raw`
const filterState = {
  packages: new Set(),
  kinds: new Set(),
  includeTests: false,
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

function renderFilterChips(container, catalog) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  function makeChip(label, isActive, onclick) {
    const chip = el('span', {
      class: 'code-paths-chip' + (isActive ? ' active' : ''),
      text: label,
      onclick,
    });
    return chip;
  }

  // Packages
  for (const pkg of packagesInCatalog(catalog)) {
    container.appendChild(makeChip(pkg, filterState.packages.has(pkg), () => {
      if (filterState.packages.has(pkg)) filterState.packages.delete(pkg);
      else filterState.packages.add(pkg);
      renderFilterChips(container, catalog);
      notifyViews();
    }));
  }
  // Spacer
  container.appendChild(el('span', { class: 'code-paths-chip', style: 'pointer-events:none;background:transparent;border-color:transparent;', text: '·' }));
  // Kinds
  for (const kind of KIND_LIST) {
    container.appendChild(makeChip(kind, filterState.kinds.has(kind), () => {
      if (filterState.kinds.has(kind)) filterState.kinds.delete(kind);
      else filterState.kinds.add(kind);
      renderFilterChips(container, catalog);
      notifyViews();
    }));
  }
  // Spacer
  container.appendChild(el('span', { class: 'code-paths-chip', style: 'pointer-events:none;background:transparent;border-color:transparent;', text: '·' }));
  // Test/prod toggle
  container.appendChild(makeChip(filterState.includeTests ? 'incl. tests' : 'prod only', filterState.includeTests, () => {
    filterState.includeTests = !filterState.includeTests;
    renderFilterChips(container, catalog);
    notifyViews();
  }));
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
