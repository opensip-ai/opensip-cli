/**
 * @fileoverview Display configuration for fitness checks
 *
 * Maps check slugs to display entries (icon + display name) for CLI and dashboard output.
 * Falls back to kebab-to-title-case conversion for unknown slugs.
 */

import { ARCHITECTURE_DISPLAY, DOCUMENTATION_DISPLAY } from './architecture.js'
import { QUALITY_DISPLAY } from './quality.js'
import { RESILIENCE_DISPLAY } from './resilience.js'
import { SECURITY_DISPLAY, TESTING_DISPLAY } from './security-testing.js'
import type { CheckDisplayEntry } from './types.js'

export type { CheckDisplayEntry }

/** Combined check display configuration */
export const CHECK_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  ...ARCHITECTURE_DISPLAY,
  ...DOCUMENTATION_DISPLAY,
  ...QUALITY_DISPLAY,
  ...RESILIENCE_DISPLAY,
  ...SECURITY_DISPLAY,
  ...TESTING_DISPLAY,
})

export {
  ARCHITECTURE_DISPLAY,
  DOCUMENTATION_DISPLAY,
  QUALITY_DISPLAY,
  RESILIENCE_DISPLAY,
  SECURITY_DISPLAY,
  TESTING_DISPLAY,
}

/** Get the icon for a check by slug. Falls back to magnifying glass. */
export function getCheckIcon(checkSlug: string): string {
  const display = CHECK_DISPLAY[checkSlug]
  return display ? display[0] : '\uD83D\uDD0D'
}

/** Get the display name for a check by slug. Falls back to kebab-to-title-case. */
export function getCheckDisplayName(checkSlug: string): string {
  const display = CHECK_DISPLAY[checkSlug]
  if (display) return display[1]
  return checkSlug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
