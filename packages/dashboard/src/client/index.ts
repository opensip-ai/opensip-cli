// @fitness-ignore-file module-coupling-fan-out -- Bundle aggregator: imports every migrated client module to compose the single inlined <script> and to re-expose the bridge globals; fan-out is intrinsic to its role as the esbuild entry point.
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

import { renderCatalogProvenance } from './catalog-provenance.js';
import { renderGraphRecipeCatalog, renderGraphRuleCatalog } from './catalog-recipes-tables.js';
import { renderChecksCatalog } from './checks.js';
import { openCodePathsSession, renderCodePathsTab } from './code-paths-panel.js';
import { el } from './el.js';
import { filterState, KIND_LIST, packagesInCatalog, passesFilter } from './filters.js';
import { closeFunctionCard, openFunctionCard } from './function-card.js';
import { makeSectionHeading, renderFunctionRows } from './function-row.js';
import { openHelpDrawer } from './help-drawer.js';
import { buildIndexes, resolveCalleeOcc } from './indexes.js';
import { renderOverview } from './overview.js';
import { paginateTable } from './pagination.js';
import { displayName, packageOfPath, pkgOf, shortPkg } from './path-utils.js';
import { renderRecipesPanel } from './recipes.js';
import { fuzzyMatch } from './search.js';
import { renderSessionTable } from './sessions.js';
import { makeSortable } from './sortable.js';
import { renderSubtabBar } from './subtab-bar.js';
import { activateTabForSession, registerTabActivator } from './tab-activators.js';
import { renderFitnessTab, renderSimulationTab, renderYagniTab } from './tool-tabs.js';
import { defineRankedView } from './view-template.js';
import { activateView, views } from './views-registry.js';
// Side-effect-only module: tab-bar wires the #tab-bar click handler at load.
// (sortable also schedules its setTimeout(0) `.data-table.sortable` activation
// pass as a load-time side effect, imported above for `makeSortable`. help-drawer
// attaches its document-level Escape keydown handler at load, imported above for
// `openHelpDrawer`.)
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
  renderYagniTab: typeof renderYagniTab;
  // Code Paths panel entry (L4): `renderCodePathsTab` is invoked by name in
  // generator.ts's render block (the registry-derived `renderCodePathsTab();`
  // call), and `openCodePathsSession` is read by the end-to-end validation test
  // through the booted page scope.
  renderCodePathsTab: typeof renderCodePathsTab;
  openCodePathsSession: typeof openCodePathsSession;
  // Code Paths prelude (L4): the views (view-coupling / view-distribution /
  // view-graph + view-template) and the panel now live in the bundle, so these
  // helpers are imported directly there. They stay exposed because the jsdom
  // test harnesses build fixtures from the bundle and read them as page globals.
  packageOfPath: typeof packageOfPath;
  shortPkg: typeof shortPkg;
  pkgOf: typeof pkgOf;
  displayName: typeof displayName;
  buildIndexes: typeof buildIndexes;
  resolveCalleeOcc: typeof resolveCalleeOcc;
  filterState: typeof filterState;
  KIND_LIST: typeof KIND_LIST;
  packagesInCatalog: typeof packagesInCatalog;
  passesFilter: typeof passesFilter;
  fuzzyMatch: typeof fuzzyMatch;
  makeSectionHeading: typeof makeSectionHeading;
  renderFunctionRows: typeof renderFunctionRows;
  openFunctionCard: typeof openFunctionCard;
  closeFunctionCard: typeof closeFunctionCard;
  views: typeof views;
  activateView: typeof activateView;
  // The ranked-view extension point: third-party tabs can register a ranked-list
  // view (and the jsdom tests exercise its config branches through it).
  defineRankedView: typeof defineRankedView;
  openHelpDrawer: typeof openHelpDrawer;
  renderCatalogProvenance: typeof renderCatalogProvenance;
  renderGraphRuleCatalog: typeof renderGraphRuleCatalog;
  renderGraphRecipeCatalog: typeof renderGraphRecipeCatalog;
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
g.renderYagniTab = renderYagniTab;
// Code Paths panel entry + prelude bridge globals (L4).
g.renderCodePathsTab = renderCodePathsTab;
g.openCodePathsSession = openCodePathsSession;
g.packageOfPath = packageOfPath;
g.shortPkg = shortPkg;
g.pkgOf = pkgOf;
g.displayName = displayName;
g.buildIndexes = buildIndexes;
g.resolveCalleeOcc = resolveCalleeOcc;
g.filterState = filterState;
g.KIND_LIST = KIND_LIST;
g.packagesInCatalog = packagesInCatalog;
g.passesFilter = passesFilter;
g.fuzzyMatch = fuzzyMatch;
g.makeSectionHeading = makeSectionHeading;
g.renderFunctionRows = renderFunctionRows;
g.openFunctionCard = openFunctionCard;
g.closeFunctionCard = closeFunctionCard;
g.views = views;
g.activateView = activateView;
g.defineRankedView = defineRankedView;
g.openHelpDrawer = openHelpDrawer;
g.renderCatalogProvenance = renderCatalogProvenance;
g.renderGraphRuleCatalog = renderGraphRuleCatalog;
g.renderGraphRecipeCatalog = renderGraphRecipeCatalog;
