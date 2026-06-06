/**
 * @opensip-tools/checks-universal — Cross-language fitness checks for opensip-tools
 *
 * This package follows the plugin contract: exports `checks` array and a
 * `checkDisplay` map. The CLI auto-discovers it via the same code path
 * used for every other `@opensip-tools/checks-*` package.
 *
 * Scope: checks that operate on raw text, regex, file globs, or
 * language-agnostic config (Docker, .env, READMEs, generic file structure).
 * They could apply to any codebase regardless of language.
 */

import { collectCheckObjects } from '@opensip-tools/fitness'

import * as allChecks from './checks/index.js'
import { CHECK_DISPLAY } from './display/index.js'

import type { CheckDisplayEntry, Check  } from '@opensip-tools/fitness'

/** All cross-language checks, exported as a flat array per plugin contract */
export const checks: readonly Check[] = collectCheckObjects(allChecks)

/**
 * Display map for this package's checks, contributed to the CLI's merged
 * display registry. Part of the FitPluginExports contract.
 */
export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = CHECK_DISPLAY

// Display helpers (legacy export — prefer the `checkDisplay` plugin contract field)
export { getCheckDisplayName, getCheckIcon, CHECK_DISPLAY } from './display/index.js'
export type { CheckDisplayEntry } from './display/types.js'

// Direct exports of individual checks for convenience / backward compatibility
export { fileLengthLimit } from './checks/file-length-limit.js'
export { graphIgnoreHygiene } from './checks/quality/graph-ignore-hygiene.js'
export { noTodoComments } from './checks/no-todo-comments.js'
export { noUnimplementedMarkers } from './checks/no-unimplemented-markers.js'
