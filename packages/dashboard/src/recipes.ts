/**
 * Recipes catalog rendering — shows available recipes with their configuration.
 * Returns JS code as a string.
 */

export function dashboardRecipesJs(): string {
  return `
// =======================================================
// RECIPES CATALOG
// =======================================================

function renderRecipesPanel(container, recipesData) {
  if (!recipesData || !recipesData.length) {
    container.appendChild(el('div', {class:'empty', text:'No recipes available.'}));
    return;
  }

  const table = el('table', {class:'data-table'});
  const thead = el('thead');
  const headerRow = el('tr');
  ['Recipe', 'Description', 'Selector', 'Mode', 'Timeout', 'Tags'].forEach(h => {
    headerRow.appendChild(el('th', {text: h}));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  recipesData.forEach(recipe => {
    const row = el('tr');

    // Name
    const nameCell = el('td', {style:'font-weight:500'});
    nameCell.appendChild(el('div', {text: recipe.displayName}));
    nameCell.appendChild(el('div', {text: recipe.name, style:'font-size:11px;color:var(--text-dim);font-weight:400'}));
    row.appendChild(nameCell);

    // Description
    row.appendChild(el('td', {text: recipe.description, style:'color:var(--text-muted)'}));

    // Selector type
    const selCell = el('td');
    selCell.appendChild(el('span', {class:'badge', style:'background:var(--bg-hover);color:var(--text-muted)', text: recipe.selectorType}));
    row.appendChild(selCell);

    // Mode
    const modeCell = el('td');
    const modeColor = recipe.mode === 'parallel' ? 'color:var(--success)' : 'color:var(--warning)';
    modeCell.appendChild(el('span', {text: recipe.mode, style: modeColor + ';font-size:12px'}));
    row.appendChild(modeCell);

    // Timeout
    row.appendChild(el('td', {text: (recipe.timeout / 1000) + 's', style:'color:var(--text-dim);font-size:12px'}));

    // Tags
    const tagsCell = el('td');
    (recipe.tags || []).forEach(t => {
      tagsCell.appendChild(el('span', {class:'tag-badge', text: t}));
    });
    row.appendChild(tagsCell);

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(el('div', {class:'card'}, [table]));
}
`;
}
