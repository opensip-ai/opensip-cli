/**
 * Tool tab rendering — creates subtabs (Sessions / Catalog / Recipes) under each
 * tool tab.
 *
 * Delegates the subtab DOM/click pattern to the shared `renderSubtabBar`
 * Strategy (F2). The three-subtab shape is a config — `[overview, catalog,
 * recipes]` — so a tool with a different shape (e.g. Code Paths' two subtabs) is
 * also a config call rather than a duplicated DOM block.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The per-tool
 * `renderFitnessTab` / `renderSimulationTab` stay exposed as page globals because
 * generator.ts invokes them by bare name (the registry's `renderFunctionName`).
 */

import { renderChecksCatalog } from './checks.js';
import { el } from './el.js';
import { renderRecipesPanel } from './recipes.js';
import { renderSessionTable } from './sessions.js';
import { renderSubtabBar } from './subtab-bar.js';

/** Renders a tool's catalog data (checks, scenarios, …) into a subpanel. */
type CatalogRenderer = (container: HTMLElement, data: readonly unknown[]) => void;

/**
 * Render a tool tab with subtabs: Sessions | Catalog | Recipes (the first subtab
 * keeps the stable id 'overview' for routing). `recipesData` is passed in so each
 * tool can carry its own recipe namespace; today fit and sim pass their global
 * recipe catalog through.
 */
function renderToolTab(
  panelId: string,
  toolSessions: readonly DashboardSession[],
  accentColor: string,
  catalogLabel: string,
  catalogData: readonly unknown[],
  renderCatalogFn: CatalogRenderer,
  recipesData: readonly unknown[],
): void {
  const panel = document.querySelector<HTMLElement>('#' + panelId);
  if (!panel) return;
  renderSubtabBar(panel, [
    {
      id: 'overview',
      label: 'Sessions',
      render: (p) => {
        renderSessionTable(p, toolSessions, accentColor);
      },
    },
    {
      id: 'catalog',
      label: catalogLabel,
      render: (p) => {
        if (catalogData && catalogData.length > 0) {
          renderCatalogFn(p, catalogData);
        } else {
          p.append(
            el('div', {
              class: 'empty',
              text: 'No ' + catalogLabel.toLowerCase() + ' available yet.',
            }),
          );
        }
      },
    },
    {
      id: 'recipes',
      label: 'Recipes',
      render: (p) => {
        renderRecipesPanel(p, recipesData);
      },
    },
  ]);
}

export function renderFitnessTab(): void {
  renderToolTab(
    'panel-fitness',
    fitSessions,
    'var(--accent-fitness)',
    'Checks',
    checkCatalog,
    (container, data) => renderChecksCatalog(container, data),
    recipeCatalog,
  );
}

/** A sim scenario catalog entry (sim domain vocabulary, read structurally). */
interface ScenarioEntry {
  name: string;
  kind?: string;
  description?: string;
  tags?: string[];
}

// Render the registered sim scenarios as simple rows (name + kind badge +
// description + tags). Only invoked when the catalog is non-empty (renderToolTab
// shows a graceful empty state otherwise).
function renderScenariosCatalog(container: HTMLElement, catalogData: readonly unknown[]): void {
  const scenarios = catalogData as readonly ScenarioEntry[];
  const table = el('table', { class: 'session-table' });
  const tbody = el('tbody');
  [...scenarios]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((s) => {
      const row = el('tr');
      const nameCell = el('td');
      nameCell.append(el('strong', { text: s.name }));
      if (s.kind)
        nameCell.append(el('span', { class: 'badge', text: s.kind, style: 'margin-left:8px' }));
      if (s.description)
        nameCell.append(
          el('div', { class: 'muted', style: 'font-size:12px', text: s.description }),
        );
      row.append(nameCell);
      const tagsCell = el('td');
      (s.tags ?? []).slice(0, 4).forEach((t) => {
        tagsCell.append(el('span', { class: 'tag-badge', text: t }));
      });
      row.append(tagsCell);
      tbody.append(row);
    });
  table.append(tbody);
  container.append(table);
}

export function renderSimulationTab(): void {
  renderToolTab(
    'panel-simulation',
    simSessions,
    'var(--accent-sim)',
    'Scenarios',
    simScenarioCatalog,
    (container, data) => renderScenariosCatalog(container, data),
    simRecipeCatalog,
  );
}
