/**
 * @fileoverview `@opensip-tools/fitness/internal` — engine internals exposed
 * ONLY for cross-package test suites.
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-tools/fitness/internal` (enforced by dependency-cruiser per
 * ADR-0009). `executeFit` lives here because the CLI drives fitness through
 * the Tool contract (`fitnessTool`), not by calling `executeFit` directly;
 * the only external consumer is the SaaS-mode concurrency smoke test.
 */

export { executeFit } from './cli/fit.js';
