/**
 * @fileoverview Fitness plugin export contract
 *
 * What a fit-domain plugin exports.
 * Held in fitness because it references Check / FitnessRecipe — types
 * the kernel doesn't know about.
 */


import type { Check } from '../framework/check-types.js'
import type { FitnessRecipe } from '../recipes/types.js'

/**
 * Display entry for a fitness check: `[icon, displayName]`.
 *
 * Check packages contribute display metadata for their own checks by exporting
 * a `checkDisplay` map. The CLI merges these from every loaded package; later
 * registrations win on key collision. Slugs without an entry fall back to
 * kebab-to-title-case.
 *
 * Owned by fitness (ADR-0009): this is tool-specific vocabulary that used to
 * live in the kernel; check packs import it from `@opensip-tools/fitness`.
 */
export type CheckDisplayEntry = readonly [icon: string, displayName: string]

/** What a fitness plugin package/file exports */
export interface FitPluginExports {
  readonly checks?: readonly Check[]
  readonly recipes?: readonly FitnessRecipe[]
  /**
   * Optional display map: check slug → [icon, displayName].
   * The CLI merges these from every loaded check package and uses
   * the merged map when rendering tables and dashboard catalog entries.
   */
  readonly checkDisplay?: Readonly<Record<string, CheckDisplayEntry>>
}
