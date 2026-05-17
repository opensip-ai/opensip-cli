/**
 * Path-utils — `packageOfPath(filePath)` smoke tests (§11.2).
 */

import { describe, expect, it } from 'vitest';

import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';

function loadPackageOfPath(): (p: string) => string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const fn = new Function(dashboardPathUtilsJs() + '\nreturn packageOfPath;')() as (p: string) => string;
  return fn;
}

describe('packageOfPath', () => {
  it('extracts the package directory from a packages/<name>/... path', () => {
    const f = loadPackageOfPath();
    expect(f('packages/contracts/src/index.ts')).toBe('contracts');
  });

  it('handles nested workspaces under packages/<scope>/<name>/ ...', () => {
    const f = loadPackageOfPath();
    // The current heuristic returns the first segment under packages/, which
    // for "packages/fitness/engine/src/cli/dashboard.ts" is "fitness". This
    // mirrors the design's "package = workspace folder name" interpretation.
    expect(f('packages/fitness/engine/src/cli/dashboard.ts')).toBe('fitness');
  });

  it('returns <unknown> for non-package paths', () => {
    const f = loadPackageOfPath();
    expect(f('not-a-package/foo.ts')).toBe('<unknown>');
  });

  it('returns <unknown> for empty input', () => {
    const f = loadPackageOfPath();
    expect(f('')).toBe('<unknown>');
  });
});
