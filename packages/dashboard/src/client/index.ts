/**
 * Dashboard client-bundle entry (L4 migration).
 *
 * Modules migrated out of the legacy `String.raw` emitters are imported here and
 * bundled (esbuild, IIFE) by `scripts/bundle-client.mjs` into one inlined
 * `<script>` chunk that `generator.ts` emits BEFORE the remaining string-emitted
 * modules.
 *
 * ## The bridge (incremental migration)
 * The legacy modules still run as concatenated strings in the SAME `<script>`
 * scope and call helpers like `el` as free identifiers. Until they too move into
 * this bundle, each migrated helper the string modules (or generator.ts's render
 * block) call by bare name is re-exposed on `globalThis` here so those
 * free-identifier references keep resolving. As modules migrate in, they import
 * the helper directly and the corresponding `globalThis.*` assignment is removed.
 *
 * Helpers consumed ONLY by other already-migrated modules (e.g. `renderPageButtons`,
 * `paginateGroupedRows`, `statusBadge`) are imported directly in those modules and
 * need no global — only the bridge surface below is exposed.
 */

import { renderChecksCatalog } from './checks.js';
import { el } from './el.js';
import { renderOverview } from './overview.js';
import { paginateTable } from './pagination.js';
import { renderRecipesPanel } from './recipes.js';
import { renderSessionTable } from './sessions.js';
import { makeSortable } from './sortable.js';
import { renderSubtabBar } from './subtab-bar.js';
import { activateTabForSession, registerTabActivator } from './tab-activators.js';
import { renderFitnessTab, renderSimulationTab } from './tool-tabs.js';
// Side-effect-only module: tab-bar wires the #tab-bar click handler at load.
// (sortable also schedules its setTimeout(0) `.data-table.sortable` activation
// pass as a load-time side effect, imported above for `makeSortable`.)
import './tab-bar.js';

// Expose the migrated helpers as page globals so the still-string-emitted client
// modules (Code Paths) and generator.ts's render block — which run in the same
// <script> scope and call them by bare name — keep resolving them during the
// incremental L4 migration. A local cast avoids polluting the global type surface;
// as modules migrate into this bundle they import these directly and the
// corresponding assignment shrinks away.
interface ClientGlobals {
  el: typeof el;
  paginateTable: typeof paginateTable;
  makeSortable: typeof makeSortable;
  registerTabActivator: typeof registerTabActivator;
  activateTabForSession: typeof activateTabForSession;
  renderSubtabBar: typeof renderSubtabBar;
  renderSessionTable: typeof renderSessionTable;
  renderChecksCatalog: typeof renderChecksCatalog;
  renderRecipesPanel: typeof renderRecipesPanel;
  renderOverview: typeof renderOverview;
  renderFitnessTab: typeof renderFitnessTab;
  renderSimulationTab: typeof renderSimulationTab;
}
const g = globalThis as typeof globalThis & ClientGlobals;
g.el = el;
g.paginateTable = paginateTable;
g.makeSortable = makeSortable;
g.registerTabActivator = registerTabActivator;
g.activateTabForSession = activateTabForSession;
g.renderSubtabBar = renderSubtabBar;
g.renderSessionTable = renderSessionTable;
g.renderChecksCatalog = renderChecksCatalog;
g.renderRecipesPanel = renderRecipesPanel;
g.renderOverview = renderOverview;
g.renderFitnessTab = renderFitnessTab;
g.renderSimulationTab = renderSimulationTab;
