/**
 * @fileoverview Discriminator + cross-kind shared types for the scenario kind system.
 *
 * Per DEC-338, the scenario framework supports four kinds, each with its own
 * author-facing entry point and per-kind result outcome:
 *
 *   - `load`           — personas + ramp + sustain + assert SLO metrics
 *   - `chaos`          — base load + failure injection + recovery assertions
 *   - `invariant`      — seed → act → assert state
 *   - `fix-evaluation` — run agent against a signal → score predicate
 *
 * The discriminator is internal to the framework. Authors call the kind-specific
 * `defineXxxScenario` entry point; that entry point sets `kind` on the resulting
 * `RunnableScenario`. The discriminated union over `ScenarioExecutorResult`
 * lets persistence + dashboard code dispatch on `kind` without leaking
 * kind-internal types.
 */

/** Scenario kind discriminator. */
export type ScenarioKind = 'load' | 'chaos' | 'invariant' | 'fix-evaluation'

/** All scenario kinds, frozen for runtime iteration. */
export const SCENARIO_KINDS: readonly ScenarioKind[] = Object.freeze([
  'load',
  'chaos',
  'invariant',
  'fix-evaluation',
])
