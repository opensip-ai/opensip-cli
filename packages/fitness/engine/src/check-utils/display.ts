/**
 * @fileoverview Shared display-lookup helpers for fitness check packs.
 *
 * Each check pack contributes its own slug -> [icon, displayName] map; these
 * helpers do the lookup against that map with a sensible fallback. Previously
 * each pack carried a byte-identical copy of this lookup logic — surfaced by
 * the graph tool's duplicated-function-body rule.
 */

import type { CheckDisplayEntry } from '../plugins/types.js'

/** Default fallback icon when a slug isn't in the display map. */
const DEFAULT_ICON = '🔍'

/**
 * Get the icon for a check by slug. Falls back to the magnifying-glass emoji
 * when the slug isn't present in the supplied display map.
 */
export function getCheckIcon(
  displayMap: Readonly<Record<string, CheckDisplayEntry>>,
  checkSlug: string,
): string {
  const display = displayMap[checkSlug]
  return display ? display[0] : DEFAULT_ICON
}

/**
 * Get the display name for a check by slug. Falls back to kebab-to-title-case
 * conversion of the slug itself when no entry exists in the display map.
 */
export function getCheckDisplayName(
  displayMap: Readonly<Record<string, CheckDisplayEntry>>,
  checkSlug: string,
): string {
  const display = displayMap[checkSlug]
  if (display) return display[1]
  return checkSlug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Display helpers bound to a single check pack's display map.
 */
export interface DisplayHelpers {
  /** Get the icon for a check by slug. Falls back to the magnifying-glass emoji. */
  getCheckIcon: (checkSlug: string) => string
  /** Get the display name for a check by slug. Falls back to kebab-to-title-case. */
  getCheckDisplayName: (checkSlug: string) => string
}

/**
 * Binds the shared display-lookup logic to a per-pack `CHECK_DISPLAY` map,
 * returning slug-only `getCheckIcon` / `getCheckDisplayName` closures.
 *
 * Each check pack owns its own display data but the binding wrapper was
 * previously byte-identical across packs (flagged by the graph tool's
 * duplicated-function-body rule); this factory keeps the data/logic split
 * intact while erasing the wrapper twin.
 */
export function makeDisplayHelpers(
  displayMap: Readonly<Record<string, CheckDisplayEntry>>,
): DisplayHelpers {
  return {
    getCheckIcon: (checkSlug) => getCheckIcon(displayMap, checkSlug),
    getCheckDisplayName: (checkSlug) => getCheckDisplayName(displayMap, checkSlug),
  }
}
