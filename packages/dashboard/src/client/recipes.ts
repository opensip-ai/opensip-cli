/**
 * Recipes catalog rendering — shows available recipes with their configuration.
 *
 * `renderRecipesPanel(container, recipesData)` renders a static table of recipe
 * descriptors (name, description, selector type, mode, timeout, tags).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 * `renderRecipesPanel` stays exposed as a page global because the still-string-
 * emitted Code Paths panel can reach for it by bare name.
 */

import { el } from './el.js';

/** A recipe catalog entry (tool domain vocabulary, read structurally). */
interface RecipeEntry {
  name: string;
  displayName: string;
  description: string;
  selectorType: string;
  mode: string;
  timeout: number;
  tags?: string[];
}

export function renderRecipesPanel(
  container: HTMLElement,
  recipesData: readonly unknown[] | null | undefined,
): void {
  const recipes = recipesData as readonly RecipeEntry[] | null | undefined;
  if (!recipes?.length) {
    container.append(el('div', { class: 'empty', text: 'No recipes available.' }));
    return;
  }

  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Recipe', 'Description', 'Selector', 'Mode', 'Timeout', 'Tags'].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  recipes.forEach((recipe) => {
    const row = el('tr');

    // Name.
    const nameCell = el('td', { style: 'font-weight:500' });
    nameCell.append(el('div', { text: recipe.displayName }));
    nameCell.append(
      el('div', {
        text: recipe.name,
        style: 'font-size:11px;color:var(--text-dim);font-weight:400',
      }),
    );
    row.append(nameCell);

    // Description.
    row.append(el('td', { text: recipe.description, style: 'color:var(--text-muted)' }));

    // Selector type.
    const selCell = el('td');
    selCell.append(
      el('span', {
        class: 'badge',
        style: 'background:var(--bg-hover);color:var(--text-muted)',
        text: recipe.selectorType,
      }),
    );
    row.append(selCell);

    // Mode.
    const modeCell = el('td');
    const modeColor = recipe.mode === 'parallel' ? 'color:var(--success)' : 'color:var(--warning)';
    modeCell.append(el('span', { text: recipe.mode, style: modeColor + ';font-size:12px' }));
    row.append(modeCell);

    // Timeout.
    row.append(
      el('td', {
        text: recipe.timeout / 1000 + 's',
        style: 'color:var(--text-dim);font-size:12px',
      }),
    );

    // Tags.
    const tagsCell = el('td');
    (recipe.tags ?? []).forEach((t) => {
      tagsCell.append(el('span', { class: 'tag-badge', text: t }));
    });
    row.append(tagsCell);

    tbody.append(row);
  });

  table.append(tbody);
  container.append(el('div', { class: 'card' }, [table]));
}
