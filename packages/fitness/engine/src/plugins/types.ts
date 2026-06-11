/**
 * @fileoverview Fitness plugin export contract
 *
 * What a fit-domain plugin exports.
 * Held in fitness because it references Check / FitnessRecipe — types
 * the kernel doesn't know about.
 */

import type { Check } from '../framework/check-types.js';
import type { FitnessRecipe } from '../recipes/types.js';

/**
 * Display entry for a fitness check: `[icon, displayName]`.
 *
 * A check pack keeps its checks' display in an authoring `CHECK_DISPLAY` map
 * (slug → `[icon, displayName]`) and folds it ONTO its checks via
 * `applyCheckDisplay` at the pack barrel — so display travels on each check's
 * `config` (§5.3 separate-domains fold). There is no separate `checkDisplay`
 * plugin export and no merged-display singleton; slugs without an entry fall
 * back to kebab-to-title-case + a default icon.
 *
 * Owned by fitness (ADR-0009): this is tool-specific vocabulary that used to
 * live in the kernel; check packs import it from `@opensip-tools/fitness`.
 */
export type CheckDisplayEntry = readonly [icon: string, displayName: string];

/** What a fitness plugin package/file exports */
export interface FitPluginExports {
  readonly checks?: readonly Check[];
  readonly recipes?: readonly FitnessRecipe[];
}
