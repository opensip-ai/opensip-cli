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

// Per-check fixture-coverage test infrastructure (testing gap P0). Pure,
// vitest-free helpers consumed by each check pack's fixture-coverage.test.ts;
// the harness that exercises a fixture lands in Phase 1.
export {
  buildFixtureManifest,
  validateBookkeeping,
  extForLanguage,
  LANGUAGE_EXTENSION,
  type FixtureDomain,
  type CheckFixtureRequirement,
  type CoverageAllowlist,
  type CommandExemptions,
  type FilenameOverrides,
  type BuildManifestOptions,
  type CoverageConfig,
} from './fixture-coverage/manifest.js';
export {
  runCheckOnFixture,
  planCoverageCases,
  type FixtureFile,
  type FixtureCase,
  type FixtureRun,
  type FixtureVariant,
  type CoverageCase,
} from './fixture-coverage/run-check-on-fixture.js';
