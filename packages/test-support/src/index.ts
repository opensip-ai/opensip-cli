/**
 * @fileoverview `@opensip-cli/test-support` — cross-package TEST scaffolding
 * (ADR-0040).
 *
 * PRIVATE and unpublished: this package is a devDependency-only surface for
 * the workspace's own test suites. Production source in any package must
 * never import it (enforced by dependency-cruiser); it must never appear in
 * a publishable package's `dependencies`.
 *
 * Two scaffolding families live here:
 *
 * - Scope helpers (`makeTestScope` / `withScope` / `withScopeSync`) — sugar
 *   over `@opensip-cli/core`'s public `RunScope` API for tests that
 *   exercise registry-aware code paths. Formerly the published
 *   `@opensip-cli/core/test-utils/with-scope.js` subpath.
 * - Per-check fixture-coverage harness (`runCheckOnFixture`,
 *   `planCoverageCases`, `buildFixtureManifest`, ...) — the manifest +
 *   fixture runners each check pack's `fixture-coverage.test.ts` consumes.
 *   Formerly exposed through `@opensip-cli/fitness/internal`.
 *
 * NOTE: because this package depends on `@opensip-cli/fitness`, the fitness
 * engine's own tests must NOT import it (the package graph would go cyclic);
 * they use core's public `RunScope` API directly.
 */

export { makeTestScope, makeFitnessTestScope, withScope, withScopeSync } from './with-scope.js';
export { runTwoScopesConcurrently } from './concurrent-scopes.js';

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
