/**
 * @fileoverview `@opensip-cli/fitness/internal` — engine internals exposed
 * ONLY for cross-package test suites (and private test-support).
 *
 * This is NOT public API. Production code in other packages must not import
 * from `@opensip-cli/fitness/internal` (enforced by dependency-cruiser). The
 * subpath is declared in package exports for workspace tests but is
 * unsupported for sibling production source.
 *
 * `executeFit` lives here because the CLI drives fitness through the Tool
 * contract (`fitnessTool`), not by calling `executeFit` directly.
 * `fitnessTestFileCache` is the test-only module singleton for check-pack
 * fixture prewarm (formerly public `fileCache`).
 */

export { executeFit } from './cli/fit.js';
/** Test-only FileCache singleton — not a production runtime value. */
export { fileCache as fitnessTestFileCache } from './framework/file-cache.js';
