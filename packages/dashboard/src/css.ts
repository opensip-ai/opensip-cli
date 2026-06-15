/**
 * Dashboard CSS — concatenates the per-concern stylesheets in
 * `css/` into the single `<style>` block the generator inlines.
 *
 * Pre-F12 this was a 220-line `String.raw` literal mixing eight
 * concerns (theme tokens, header, tabs, subtabs, cards/stats,
 * data-table, pagination, badges, code-paths views, function-card
 * overlay, help-drawer). Each concern is now its own file in
 * `css/`; the order below matches the original source order so
 * the emitted stylesheet remains byte-stable for snapshot tests.
 */

import { dashboardCssCards } from './css/cards.js';
import { dashboardCssCodePaths } from './css/code-paths.js';
import { dashboardCssDataTable } from './css/data-table.js';
import { dashboardCssFunctionCard } from './css/function-card.js';
import { dashboardCssHelpDrawer } from './css/help-drawer.js';
import { dashboardCssTabs } from './css/tabs.js';
import { dashboardCssTheme } from './css/theme.js';

export function dashboardCss(): string {
  return [
    dashboardCssTheme(),
    dashboardCssTabs(),
    dashboardCssCards(),
    dashboardCssDataTable(),
    dashboardCssCodePaths(),
    dashboardCssFunctionCard(),
    dashboardCssHelpDrawer(),
  ].join('\n');
}
