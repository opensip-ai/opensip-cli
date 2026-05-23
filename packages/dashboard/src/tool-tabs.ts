/**
 * Tool tab rendering — creates subtabs (Overview / Catalog / Recipes) under each tool tab.
 * Returns JS code as a string.
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

  // Subtab bar
  const subtabBar = el('div', {class:'subtab-bar'});
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'catalog', label: catalogLabel },
    { id: 'recipes', label: 'Recipes' },
  ];

  const panels = {};
  tabs.forEach((t, i) => {
    const subtab = el('div', {
      class: 'subtab' + (i === 0 ? ' active' : ''),
      'data-subtab': t.id,
      text: t.label,
    });
    subtabBar.appendChild(subtab);

    const subpanel = el('div', {
      class: 'subtab-panel' + (i === 0 ? ' active' : ''),
      id: panelId + '-' + t.id,
    });
    panels[t.id] = subpanel;
  });

  panel.appendChild(subtabBar);
  tabs.forEach(t => panel.appendChild(panels[t.id]));

  // Subtab switching
  subtabBar.addEventListener('click', e => {
    const tab = e.target.closest('.subtab');
    if (!tab) return;
    subtabBar.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    tabs.forEach(t => panels[t.id].classList.remove('active'));
    panels[tab.dataset.subtab].classList.add('active');
  });

  // Render Overview subtab (sessions + detail)
  renderSessionTable(panels['overview'], toolSessions, accentColor);

  // Render Catalog subtab
  if (catalogData && catalogData.length > 0) {
    renderCatalogFn(panels['catalog'], catalogData);
  } else {
    panels['catalog'].appendChild(el('div', {class:'empty', text:'No ' + catalogLabel.toLowerCase() + ' available yet.'}));
  }

  // Render Recipes subtab
  renderRecipesPanel(panels['recipes'], recipeCatalog);
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
