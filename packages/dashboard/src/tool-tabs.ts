/**
 * Tool tab rendering — creates subtabs (Overview / Catalog / Recipes) under each tool tab.
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
 * Render a tool tab with subtabs: Overview | Catalog | Recipes
 * @param panelId - e.g., 'panel-fitness'
 * @param toolSessions - filtered sessions for this tool
 * @param accentColor - CSS var for accent
 * @param catalogLabel - e.g., 'Checks', 'Scenarios', 'Assessments'
 * @param catalogData - check/scenario/assessment catalog entries (or empty)
 * @param renderCatalogFn - function(container, data) to render the catalog
 */
function renderToolTab(panelId, toolSessions, accentColor, catalogLabel, catalogData, renderCatalogFn) {
  const panel = document.getElementById(panelId);
  renderSubtabBar(panel, [
    { id: 'overview', label: 'Overview', render: function(p) {
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
      renderRecipesPanel(p, recipeCatalog);
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
    function(container, data) { renderChecksCatalog(container, data); }
  );
}

function renderSimulationTab() {
  renderToolTab(
    'panel-simulation',
    simSessions,
    'var(--accent-sim)',
    'Scenarios',
    [],  // No scenarios yet
    function(container, data) {}
  );
}

`;
}
