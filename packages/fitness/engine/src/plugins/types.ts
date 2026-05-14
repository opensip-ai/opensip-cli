/**
 * @fileoverview Fitness plugin export contract
 *
 * What an @opensip-tools/checks-* (or any fit-domain plugin) exports.
 * Held in fitness because it references Check / FitnessRecipe — types
 * the kernel doesn't know about.
 */

import type { CheckDisplayEntry, PluginMetadata } from '@opensip-tools/core'

import type { Check } from '../framework/check-types.js'
import type { FitnessRecipe } from '../recipes/types.js'

/** What a fitness plugin package/file exports */
export interface FitPluginExports {
  readonly checks?: readonly Check[]
  readonly recipes?: readonly FitnessRecipe[]
  readonly metadata?: PluginMetadata
  /**
   * Optional display map: check slug → [icon, displayName].
   * The CLI merges these from every loaded check package and uses
   * the merged map when rendering tables and dashboard catalog entries.
   */
  readonly checkDisplay?: Readonly<Record<string, CheckDisplayEntry>>
}
