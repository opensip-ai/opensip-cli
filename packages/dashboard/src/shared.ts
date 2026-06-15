/**
 * Shared dashboard JS — concatenates the per-concern emitters in
 * `shared/`.
 *
 * Pre-F9 this was a 237-line `String.raw` blob covering five
 * concerns. Each concern now lives in its own file and is composed
 * here in the order downstream emitters depend on:
 *
 *   1. tab-bar      — top-level tab switching
 *   2. tab-activators — cross-tab session-aware navigation registry
 *   3. el           — `el(tag, attrs, children)` DOM helper used by
 *                     every subsequent emitter
 *   4. pagination   — `paginateTable` / `paginateGroupedRows` /
 *                     `renderPageButtons`
 *   5. sortable     — `makeSortable` plus the global setTimeout(0)
 *                     scan that activates `.data-table.sortable`
 *
 * Any change to the order should be considered carefully — the
 * pagination helpers reference `el`, the sortable helper references
 * the pagination helpers, and the global activation pass at the end
 * fires after every preceding emitter has declared its top-level
 * names. New shared concerns should pick a slot rather than be
 * appended blindly.
 */

import { dashboardElJs } from './shared/el.js';
import { dashboardPaginationJs } from './shared/pagination.js';
import { dashboardSortableJs } from './shared/sortable.js';
import { dashboardTabActivatorsJs } from './shared/tab-activators.js';
import { dashboardTabBarJs } from './shared/tab-bar.js';

export function dashboardSharedJs(): string {
  return [
    dashboardTabBarJs(),
    dashboardTabActivatorsJs(),
    dashboardElJs(),
    dashboardPaginationJs(),
    dashboardSortableJs(),
  ].join('\n');
}
