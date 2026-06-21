/**
 * Tool tab rendering — creates subtabs (Sessions / Catalog / Recipes) under each tool tab.
 * Returns JS code as a string.
 *
 * Delegates the subtab DOM/click pattern to the shared `renderSubtabBar`
 * Strategy declared by `dashboardSubtabBarJs` (F2). The three-subtab
 * shape is now a config — `[overview, catalog, recipes]` — so a tool
 * with a different shape (e.g. Code Paths' two subtabs) is also a
 * config call rather than a duplicated DOM block.
 */

export function dashboardToolTabsJs(): string {
  return `
// =======================================================
// TOOL SUBTAB RENDERING
// =======================================================

/**
 * Render a tool tab with subtabs: Sessions | Catalog | Recipes
 * (the first subtab keeps the stable id 'overview' for routing).
 * @param panelId - e.g., 'panel-fitness'
 * @param toolSessions - filtered sessions for this tool
 * @param accentColor - CSS var for accent
 * @param catalogLabel - e.g., 'Checks', 'Scenarios'
 * @param catalogData - check/scenario catalog entries (or empty)
 * @param renderCatalogFn - function(container, data) to render the catalog
 * @param recipesData - recipe catalog entries (or empty array). Passed
 *     in so each tool can carry its own recipe namespace once recipes
 *     beyond fit are supported; today fit and sim share the global
 *     recipeCatalog by passing it through.
 */
function renderToolTab(panelId, toolSessions, accentColor, catalogLabel, catalogData, renderCatalogFn, recipesData) {
  const panel = document.getElementById(panelId);
  renderSubtabBar(panel, [
    { id: 'overview', label: 'Sessions', render: function(p) {
      renderSessionTable(p, toolSessions, accentColor);
    }},
    { id: 'catalog', label: catalogLabel, render: function(p) {
      if (catalogData && catalogData.length > 0) {
        renderCatalogFn(p, catalogData);
      } else {
        p.appendChild(el('div', {class:'empty', text:'No ' + catalogLabel.toLowerCase() + ' available yet.'}));
      }
    }},
    { id: 'recipes', label: 'Recipes', render: function(p) {
      renderRecipesPanel(p, recipesData);
    }},
  ]);
}

// =======================================================
// RENDER ALL TOOL TABS
// =======================================================

function renderFitnessTab() {
  renderToolTab(
    'panel-fitness',
    fitSessions,
    'var(--accent-fitness)',
    'Checks',
    checkCatalog,
    function(container, data) { renderChecksCatalog(container, data); },
    recipeCatalog
  );
}

// Render the registered sim scenarios as simple rows (name + kind badge +
// description + tags). Only invoked when the catalog is non-empty (renderToolTab
// shows a graceful empty state otherwise).
function renderScenariosCatalog(container, catalogData) {
  const table = el('table', {class:'session-table'});
  const tbody = el('tbody');
  [...catalogData].sort(function(a, b) { return a.name.localeCompare(b.name); }).forEach(function(s) {
    const row = el('tr');
    const nameCell = el('td');
    nameCell.appendChild(el('strong', {text: s.name}));
    if (s.kind) nameCell.appendChild(el('span', {class:'badge', text: s.kind, style:'margin-left:8px'}));
    if (s.description) nameCell.appendChild(el('div', {class:'muted', style:'font-size:12px', text: s.description}));
    row.appendChild(nameCell);
    const tagsCell = el('td');
    (s.tags || []).slice(0, 4).forEach(function(t) { tagsCell.appendChild(el('span', {class:'tag-badge', text: t})); });
    row.appendChild(tagsCell);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderSimulationTab() {
  renderToolTab(
    'panel-simulation',
    simSessions,
    'var(--accent-sim)',
    'Scenarios',
    simScenarioCatalog,
    function(container, data) { renderScenariosCatalog(container, data); },
    simRecipeCatalog
  );
}

`;
}
