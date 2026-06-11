/**
 * @fileoverview Discriminator + cross-kind shared types for the scenario kind system.
 *
 * The standalone simulation tool supports two scenario kinds, each with its own
 * author-facing entry point and per-kind result outcome:
 *
 *   - `load`           — personas + ramp + sustain + assert SLO metrics
 *   - `chaos`          — base load + failure injection + recovery assertions
 *
 * The `invariant` and `fix-evaluation` kinds were removed as parent-product-coupled
 * (standalone-CLI trim, 2026-06-05; parent DEC-338 superseded here) — they were
 * integration harnesses for the SaaS runtime (reconciler/DBOS/audit/Postgres).
 *
 * The discriminator is internal to the framework. Authors call the kind-specific
 * `defineXxxScenario` entry point; that entry point sets `kind` on the resulting
 * `RunnableScenario`. The discriminated union over `ScenarioExecutorResult`
 * lets persistence + dashboard code dispatch on `kind` without leaking
 * kind-internal types.
 */

/** Scenario kind discriminator. */
export type ScenarioKind = 'load' | 'chaos';

/** All scenario kinds, frozen for runtime iteration. */
export const SCENARIO_KINDS: readonly ScenarioKind[] = Object.freeze(['load', 'chaos']);
