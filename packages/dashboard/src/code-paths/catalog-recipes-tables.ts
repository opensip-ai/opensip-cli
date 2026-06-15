/**
 * Code Paths — Catalog & Recipes subtab tables.
 *
 * Declares the two top-level renderers the Code Paths panel mounts for its
 * "Catalog" (graph rule catalog) and "Recipes" (graph recipe catalog) subtabs.
 * Extracted from the panel orchestrator (code-paths.ts) to keep that aggregator
 * focused on wiring; both functions are pure DOM table builders that close over
 * the shared `el` helper, so they only need to be concatenated after it.
 */

export function dashboardCatalogRecipesTablesJs(): string {
  return String.raw`
// =======================================================
// CODE PATHS — CATALOG SUBTAB (graph rule catalog)
// =======================================================
function renderGraphRuleCatalog(container, rulesData) {
  if (!rulesData || !rulesData.length) {
    container.appendChild(el('div', { class: 'empty', text: 'No rules available.' }));
    return;
  }
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Rule', 'Default Severity', 'Source'].forEach(h => {
    headerRow.appendChild(el('th', { text: h }));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  rulesData.forEach(rule => {
    const row = el('tr');
    row.appendChild(el('td', { text: rule.slug, style: 'font-weight:500' }));
    const sevCell = el('td');
    const sevColor = rule.defaultSeverity === 'error' ? 'color:var(--danger)' : 'color:var(--warning)';
    sevCell.appendChild(el('span', { text: rule.defaultSeverity, style: sevColor + ';font-size:12px' }));
    row.appendChild(sevCell);
    const srcCell = el('td');
    srcCell.appendChild(el('span', { class: 'badge', style: 'background:var(--bg-hover);color:var(--text-muted)', text: rule.source }));
    row.appendChild(srcCell);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  container.appendChild(el('div', { class: 'card' }, [table]));
}

// =======================================================
// CODE PATHS — RECIPES SUBTAB (graph recipe catalog)
// =======================================================
function renderGraphRecipeCatalog(container, recipesData) {
  if (!recipesData || !recipesData.length) {
    container.appendChild(el('div', { class: 'empty', text: 'No recipes available.' }));
    return;
  }
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Recipe', 'Description', 'Selector', 'Tags'].forEach(h => {
    headerRow.appendChild(el('th', { text: h }));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  recipesData.forEach(recipe => {
    const row = el('tr');
    const nameCell = el('td', { style: 'font-weight:500' });
    nameCell.appendChild(el('div', { text: recipe.displayName }));
    nameCell.appendChild(el('div', { text: recipe.name, style: 'font-size:11px;color:var(--text-dim);font-weight:400' }));
    row.appendChild(nameCell);
    row.appendChild(el('td', { text: recipe.description, style: 'color:var(--text-muted)' }));
    const selCell = el('td');
    selCell.appendChild(el('span', { class: 'badge', style: 'background:var(--bg-hover);color:var(--text-muted)', text: recipe.selectorType }));
    row.appendChild(selCell);
    const tagsCell = el('td');
    (recipe.tags || []).forEach(t => {
      tagsCell.appendChild(el('span', { class: 'tag-badge', text: t }));
    });
    row.appendChild(tagsCell);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  container.appendChild(el('div', { class: 'card' }, [table]));
}
`;
}
