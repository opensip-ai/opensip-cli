/**
 * @opensip-tools/checks-typescript — TypeScript/Node.js fitness checks for opensip-tools
 *
 * This package follows the plugin contract: exports `checks` array, `checkDisplay`
 * map, and `metadata`. The CLI auto-discovers it via the same code path used for
 * every other `@opensip-tools/checks-*` package.
 *
 * Scope: checks that depend on the TypeScript compiler API (`typescript`),
 * `@opensip-tools/lang-typescript`, or are otherwise meaningful only inside the
 * TS/Node ecosystem (drizzle-orm, typed-inject, React-specific, etc.).
 */

import { isCheck } from '@opensip-tools/core'
import type { Check, CheckDisplayEntry } from '@opensip-tools/core'
import * as allChecks from './checks/index.js'
import { CHECK_DISPLAY } from './display/index.js'

// Collect all Check objects from the barrel exports, deduplicated by ID
function collectChecks(obj: Record<string, unknown>, seen = new Set<string>()): Check[] {
  const result: Check[] = []
  for (const value of Object.values(obj)) {
    if (isCheck(value)) {
      if (!seen.has(value.config.id)) {
        seen.add(value.config.id)
        result.push(value)
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.push(...collectChecks(value as Record<string, unknown>, seen))
    }
  }
  return result
}

/** All TypeScript-only checks, exported as a flat array per plugin contract */
export const checks: readonly Check[] = collectChecks(allChecks as unknown as Record<string, unknown>)

/**
 * Display map for this package's checks, contributed to the CLI's merged
 * display registry. Part of the FitPluginExports contract.
 */
export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = CHECK_DISPLAY

/** Plugin metadata */
export const metadata = {
  name: '@opensip-tools/checks-typescript',
  version: '1.0.0',
  description: 'TypeScript/Node.js fitness checks for opensip-tools',
}

// Display helpers (legacy export — prefer the `checkDisplay` plugin contract field)
export { getCheckDisplayName, getCheckIcon, CHECK_DISPLAY } from './display/index.js'
export type { CheckDisplayEntry } from './display/types.js'
