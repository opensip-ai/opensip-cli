/**
 * @opensip-tools/checks-typescript — TypeScript/Node.js fitness checks for opensip-tools
 *
 * This package follows the plugin contract: exports `checks` array and a
 * `checkDisplay` map. The CLI auto-discovers it via the same code path
 * used for every other `@opensip-tools/checks-*` package.
 *
 * Scope: checks that depend on the TypeScript compiler API (`typescript`),
 * `@opensip-tools/lang-typescript`, or are otherwise meaningful only inside the
 * TS/Node ecosystem (drizzle-orm, typed-inject, React-specific, etc.).
 */

import { collectCheckObjects } from '@opensip-tools/fitness'

import * as allChecks from './checks/index.js'
import { CHECK_DISPLAY } from './display/index.js'

import type { CheckDisplayEntry } from '@opensip-tools/core'
import type { Check } from '@opensip-tools/fitness'

/** All TypeScript-only checks, exported as a flat array per plugin contract */
export const checks: readonly Check[] = collectCheckObjects(allChecks)

/**
 * Display map for this package's checks, contributed to the CLI's merged
 * display registry. Part of the FitPluginExports contract.
 */
export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = CHECK_DISPLAY

// Display helpers (legacy export — prefer the `checkDisplay` plugin contract field)
export { getCheckDisplayName, getCheckIcon, CHECK_DISPLAY } from './display/index.js'
export type { CheckDisplayEntry } from './display/types.js'
