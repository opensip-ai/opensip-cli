/**
 * @opensip-cli/checks-dogfood — opensip-cli-INTERNAL architecture dogfood checks.
 *
 * PRIVATE (never published). These checks are keyed on opensip-cli's own package
 * internals and monorepo layout (ToolCliContext seams, cli-live live views,
 * bootstrap tool admission, MCP replay), so they are meaningless for an adopter
 * authoring their own Tool and must not ship in a public `checks-*` pack. They
 * load only for opensip-cli's own `fit:ci` dogfood gate, via the same
 * auto-discovery path used for every other `@opensip-cli/checks-*` package (this
 * package is declared as a root devDependency).
 *
 * Follows the plugin contract: exports a `checks` array; each check carries its
 * own display, folded on from this pack's `CHECK_DISPLAY` map via
 * `applyCheckDisplay`.
 */

import { applyCheckDisplay, collectCheckObjects } from '@opensip-cli/fitness';

import * as allChecks from './checks/index.js';
import { CHECK_DISPLAY } from './display/index.js';

import type { Check } from '@opensip-cli/fitness';

/** All dogfood architecture checks (display folded on from CHECK_DISPLAY). */
export const checks: readonly Check[] = applyCheckDisplay(
  collectCheckObjects(allChecks),
  CHECK_DISPLAY,
);

// Display helpers + the authoring map (used by tests / external display lookups).
export { getCheckDisplayName, getCheckIcon, CHECK_DISPLAY } from './display/index.js';
export type { CheckDisplayEntry } from './display/types.js';
