/**
 * @fileoverview Shared display-lookup helpers for fitness check packs.
 *
 * Each check pack contributes its own slug -> [icon, displayName] map; these
 * helpers do the lookup against that map with a sensible fallback. Previously
 * each pack carried a byte-identical copy of this lookup logic — surfaced by
 * the graph tool's duplicated-function-body rule.
 */

import type { CheckDisplayEntry } from '@opensip-tools/core'

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
