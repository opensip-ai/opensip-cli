/**
 * @fileoverview Display configuration for fitness checks
 *
 * Maps check slugs to display entries (icon + display name) for CLI and dashboard output.
 * Falls back to kebab-to-title-case conversion for unknown slugs.
 *
 * The lookup logic itself lives in @opensip-cli/fitness/check-utils; this
 * file owns only the per-pack CHECK_DISPLAY map and binds the shared helpers
 * to it.
 */

import { makeDisplayHelpers } from '@opensip-cli/fitness';

import { ARCHITECTURE_DISPLAY, DOCUMENTATION_DISPLAY } from './architecture.js';
import { QUALITY_DISPLAY } from './quality.js';
import { RESILIENCE_DISPLAY } from './resilience.js';
import { SECURITY_DISPLAY, TESTING_DISPLAY } from './security-testing.js';

import type { CheckDisplayEntry } from './types.js';

/** Combined check display configuration */
export const CHECK_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  ...ARCHITECTURE_DISPLAY,
  ...DOCUMENTATION_DISPLAY,
  ...QUALITY_DISPLAY,
  ...RESILIENCE_DISPLAY,
  ...SECURITY_DISPLAY,
  ...TESTING_DISPLAY,
});

/**
 * Slug-only display lookups bound to this pack's CHECK_DISPLAY map. The lookup
 * logic lives in @opensip-cli/fitness; this file owns only the data.
 */
export const { getCheckIcon, getCheckDisplayName } = makeDisplayHelpers(CHECK_DISPLAY);

export { type CheckDisplayEntry } from './types.js';
