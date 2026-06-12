/**
 * @fileoverview `@opensip-cli/fitness/internal` — engine internals exposed
 * ONLY for cross-package test suites.
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-cli/fitness/internal` (enforced by dependency-cruiser per
 * ADR-0009), and the subpath is excluded from the published exports map.
 * `executeFit` lives here because the CLI drives fitness through the Tool
 * contract (`fitnessTool`), not by calling `executeFit` directly; the only
 * external consumer is the SaaS-mode concurrency smoke test.
 *
 * The per-check fixture-coverage harness that used to live here moved to the
 * unpublished `@opensip-cli/test-support` package (ADR-0040) — test
 * scaffolding no longer ships inside production package source.
 */

export { executeFit } from './cli/fit.js';
