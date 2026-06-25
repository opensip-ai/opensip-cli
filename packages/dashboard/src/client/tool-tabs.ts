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

/** Options for {@link renderToolTab}. */
interface ToolTabOptions {
  /** DOM id of the tool's panel element (without the leading '#'). */
  panelId: string;
  /** The tool's sessions, rendered in the Sessions subtab. */
  toolSessions: readonly DashboardSession[];
  /** CSS accent color used by the session table. */
  accentColor: string;
  /** Label for the catalog subtab (e.g. 'Checks', 'Scenarios'). */
  catalogLabel: string;
  /** Catalog rows; empty shows a graceful empty state. */
  catalogData: readonly unknown[];
  /** Renderer for the catalog data into the catalog subpanel. */
  renderCatalogFn: CatalogRenderer;
  /** The tool's recipe-catalog rows (each tool carries its own namespace). */
  recipesData: readonly unknown[];
}

/**
 * Render a tool tab with subtabs: Sessions | Catalog | Recipes (the first subtab
 * keeps the stable id 'overview' for routing). `recipesData` is passed in so each
 * tool can carry its own recipe namespace; today fit and sim pass their global
 * recipe catalog through.
 */
function renderToolTab(options: ToolTabOptions): void {
  const {
    panelId,
    toolSessions,
    accentColor,
    catalogLabel,
    catalogData,
    renderCatalogFn,
    recipesData,
  } = options;
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
  renderToolTab({
    panelId: 'panel-fitness',
    toolSessions: fitSessions,
    accentColor: 'var(--accent-fitness)',
    catalogLabel: 'Checks',
    catalogData: checkCatalog,
    renderCatalogFn: (container, data) => renderChecksCatalog(container, data),
    recipesData: recipeCatalog,
  });
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
  renderToolTab({
    panelId: 'panel-simulation',
    toolSessions: simSessions,
    accentColor: 'var(--accent-sim)',
    catalogLabel: 'Scenarios',
    catalogData: simScenarioCatalog,
    renderCatalogFn: (container, data) => renderScenariosCatalog(container, data),
    recipesData: simRecipeCatalog,
  });
}

/** A yagni detector catalog entry (yagni domain vocabulary, read structurally). */
interface YagniDetectorEntry {
  id: string;
  slug: string;
  description?: string;
}

// Reused badge style for a neutral "source"-style pill (matches graph's catalog
// Source column).
const NEUTRAL_BADGE = 'background:var(--bg-hover);color:var(--text-muted)';

// Render the bundled YAGNI detectors as a data-table card — same shape as the
// graph rule catalog (Code Graph › Catalog): a column header row + a per-row
// Source badge, with an Evidence column (graph vs static) where graph shows
// Default Severity. Only invoked when the catalog is non-empty (the YAGNI tab
// shows a graceful empty state otherwise).
function renderYagniDetectorsCatalog(
  container: HTMLElement,
  catalogData: readonly unknown[],
): void {
  // A short summary line above the table — detector count (mirrors fit's
  // "N total checks …" count). yagniSummary is null when yagni contributed no data.
  if (yagniSummary && typeof yagniSummary.detectorCount === 'number') {
    container.append(
      el('div', {
        class: 'muted',
        style: 'margin-bottom:12px',
        text: yagniSummary.detectorCount + ' detectors',
      }),
    );
  }

  const detectors = catalogData as readonly YagniDetectorEntry[];
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  const headerRow = el('tr');
  ['Detector', 'Description', 'Evidence', 'Source'].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  [...detectors]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .forEach((d) => {
      const row = el('tr');
      row.append(el('td', { text: d.slug, style: 'font-weight:500' }));
      row.append(el('td', { text: d.description ?? '', style: 'color:var(--text-muted)' }));
      const evidenceCell = el('td');
      evidenceCell.append(
        el('span', {
          class: 'badge',
          style: NEUTRAL_BADGE,
          text: 'static',
        }),
      );
      row.append(evidenceCell);
      const sourceCell = el('td');
      sourceCell.append(el('span', { class: 'badge', style: NEUTRAL_BADGE, text: 'built-in' }));
      row.append(sourceCell);
      tbody.append(row);
    });
  table.append(tbody);
  container.append(el('div', { class: 'card' }, [table]));
}

// Yagni has no recipe namespace, so it uses a two-subtab shape (Sessions |
// Detectors) built directly on renderSubtabBar rather than the three-subtab
// renderToolTab — same pattern the Code Paths tab uses for its two subtabs. The
// first subtab keeps the stable id 'overview' for cross-tab routing.
export function renderYagniTab(): void {
  const panel = document.querySelector<HTMLElement>('#panel-yagni');
  if (!panel) return;
  renderSubtabBar(panel, [
    {
      id: 'overview',
      label: 'Sessions',
      render: (p) => {
        renderSessionTable(p, yagniSessions, 'var(--accent-yagni)');
      },
    },
    {
      id: 'catalog',
      label: 'Detectors',
      render: (p) => {
        if (yagniCatalog && yagniCatalog.length > 0) {
          renderYagniDetectorsCatalog(p, yagniCatalog);
        } else {
          p.append(el('div', { class: 'empty', text: 'No detectors available yet.' }));
        }
      },
    },
  ]);
}
