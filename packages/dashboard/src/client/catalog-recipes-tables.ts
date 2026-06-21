/**
 * Code Paths — Catalog & Recipes subtab tables.
 *
 * Exports the two top-level renderers the Code Paths panel mounts for its
 * "Catalog" (graph rule catalog) and "Recipes" (graph recipe catalog) subtabs.
 * Both are pure DOM table builders that close over the shared `el` helper.
 *
 * Entry shapes are graph domain vocabulary owned by the producing tool, read
 * structurally here — hence the narrow inline shapes.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';

/** A graph rule catalog entry, read structurally. */
export interface GraphRuleEntry {
  slug: string;
  defaultSeverity: string;
  source: string;
}

/** A graph recipe catalog entry, read structurally. */
export interface GraphRecipeEntry {
  name: string;
  displayName: string;
  description: string;
  selectorType: string;
  tags?: readonly string[];
}

// =======================================================
// CODE PATHS — CATALOG SUBTAB (graph rule catalog)
// =======================================================
export function renderGraphRuleCatalog(
  container: HTMLElement,
  rulesData: readonly GraphRuleEntry[] | null | undefined,
): void {
  if (!rulesData?.length) {
    container.append(el('div', { class: 'empty', text: 'No rules available.' }));
    return;
  }
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Rule', 'Default Severity', 'Source'].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  rulesData.forEach((rule) => {
    const row = el('tr');
    row.append(el('td', { text: rule.slug, style: 'font-weight:500' }));
    const sevCell = el('td');
    const sevColor =
      rule.defaultSeverity === 'error' ? 'color:var(--danger)' : 'color:var(--warning)';
    sevCell.append(el('span', { text: rule.defaultSeverity, style: sevColor + ';font-size:12px' }));
    row.append(sevCell);
    const srcCell = el('td');
    srcCell.append(
      el('span', {
        class: 'badge',
        style: 'background:var(--bg-hover);color:var(--text-muted)',
        text: rule.source,
      }),
    );
    row.append(srcCell);
    tbody.append(row);
  });
  table.append(tbody);
  container.append(el('div', { class: 'card' }, [table]));
}

// =======================================================
// CODE PATHS — RECIPES SUBTAB (graph recipe catalog)
// =======================================================
export function renderGraphRecipeCatalog(
  container: HTMLElement,
  recipesData: readonly GraphRecipeEntry[] | null | undefined,
): void {
  if (!recipesData?.length) {
    container.append(el('div', { class: 'empty', text: 'No recipes available.' }));
    return;
  }
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Recipe', 'Description', 'Selector', 'Tags'].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  recipesData.forEach((recipe) => {
    const row = el('tr');
    const nameCell = el('td', { style: 'font-weight:500' });
    nameCell.append(el('div', { text: recipe.displayName }));
    nameCell.append(
      el('div', {
        text: recipe.name,
        style: 'font-size:11px;color:var(--text-dim);font-weight:400',
      }),
    );
    row.append(nameCell);
    row.append(el('td', { text: recipe.description, style: 'color:var(--text-muted)' }));
    const selCell = el('td');
    selCell.append(
      el('span', {
        class: 'badge',
        style: 'background:var(--bg-hover);color:var(--text-muted)',
        text: recipe.selectorType,
      }),
    );
    row.append(selCell);
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
