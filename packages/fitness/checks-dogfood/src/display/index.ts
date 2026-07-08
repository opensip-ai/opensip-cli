/**
 * @fileoverview Display configuration for checks-dogfood.
 *
 * Maps check slugs to display entries (icon + display name). The lookup logic
 * lives in @opensip-cli/fitness/check-utils; this file owns only the per-pack
 * CHECK_DISPLAY map and binds the shared helpers to it.
 */

import { makeDisplayHelpers } from '@opensip-cli/fitness';

import { ARCHITECTURE_DISPLAY } from './architecture.js';

import type { CheckDisplayEntry } from './types.js';

/** Combined check display configuration for the dogfood pack. */
export const CHECK_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  ...ARCHITECTURE_DISPLAY,
});

/**
 * Slug-only display lookups bound to this pack's CHECK_DISPLAY map. The lookup
 * logic lives in @opensip-cli/fitness; this file owns only the data.
 */
export const { getCheckIcon, getCheckDisplayName } = makeDisplayHelpers(CHECK_DISPLAY);

export { type CheckDisplayEntry } from './types.js';
