/**
 * @opensip-tools/checks-typescript — TypeScript/Node.js fitness checks for opensip-tools
 *
 * This package follows the plugin contract: it exports a `checks` array. Each
 * check carries its own display (`config.icon`/`config.displayName`), folded on
 * from this pack's `CHECK_DISPLAY` map via `applyCheckDisplay` (§5.3) — there is
 * no separate `checkDisplay` export. The CLI auto-discovers the package via the
 * same code path used for every other `@opensip-tools/checks-*` package.
 *
 * Scope: checks that depend on the TypeScript compiler API (`typescript`),
 * `@opensip-tools/lang-typescript`, or are otherwise meaningful only inside the
 * TS/Node ecosystem (drizzle-orm, typed-inject, React-specific, etc.).
 */

import { applyCheckDisplay, collectCheckObjects } from '@opensip-tools/fitness';

import * as allChecks from './checks/index.js';
import { CHECK_DISPLAY } from './display/index.js';

import type { Check } from '@opensip-tools/fitness';

/** All TypeScript-only checks (display folded on from CHECK_DISPLAY), per plugin contract. */
export const checks: readonly Check[] = applyCheckDisplay(
  collectCheckObjects(allChecks),
  CHECK_DISPLAY,
);

// Display helpers + the authoring map (used by tests / external display lookups).
export { getCheckDisplayName, getCheckIcon, CHECK_DISPLAY } from './display/index.js';
export type { CheckDisplayEntry } from './display/types.js';
