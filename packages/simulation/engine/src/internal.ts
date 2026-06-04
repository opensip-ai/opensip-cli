/**
 * @fileoverview `@opensip-tools/simulation/internal` — engine internals
 * exposed ONLY for cross-package test suites.
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-tools/simulation/internal` (enforced by dependency-cruiser
 * per ADR-0009). `executeSim` lives here because the CLI drives simulation
 * through the Tool contract (`simulationTool`), not by calling `executeSim`
 * directly; it has no external production consumer. Mirrors
 * `@opensip-tools/fitness/internal`'s `executeFit`.
 */

export { executeSim } from './cli/sim.js'
