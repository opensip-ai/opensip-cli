/**
 * Path-utils — `packageOfPath(filePath)` and `displayName(simpleName)`
 * smoke tests (§11.2).
 */

import { describe, expect, it } from 'vitest';

import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';

function loadHelpers(): { packageOfPath: (p: string) => string; displayName: (s: string) => string } {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  return new Function(dashboardPathUtilsJs() + '\nreturn { packageOfPath, displayName };')() as {
    packageOfPath: (p: string) => string;
    displayName: (s: string) => string;
  };
}

describe('packageOfPath', () => {
  it('extracts the package directory from a packages/<name>/... path', () => {
    const { packageOfPath } = loadHelpers();
    expect(packageOfPath('packages/contracts/src/index.ts')).toBe('contracts');
  });

  it('handles nested workspaces under packages/<scope>/<name>/ ...', () => {
    const { packageOfPath } = loadHelpers();
    // The current heuristic returns the first segment under packages/, which
    // for "packages/fitness/engine/src/cli/dashboard.ts" is "fitness". This
    // mirrors the design's "package = workspace folder name" interpretation.
    expect(packageOfPath('packages/fitness/engine/src/cli/dashboard.ts')).toBe('fitness');
  });

  it('returns <unknown> for non-package paths', () => {
    const { packageOfPath } = loadHelpers();
    expect(packageOfPath('not-a-package/foo.ts')).toBe('<unknown>');
  });

  it('returns <unknown> for empty input', () => {
    const { packageOfPath } = loadHelpers();
    expect(packageOfPath('')).toBe('<unknown>');
  });
});

describe('displayName', () => {
  it('passes real identifiers through unchanged', () => {
    const { displayName } = loadHelpers();
    expect(displayName('saveBaseline')).toBe('saveBaseline');
    expect(displayName('renderHotView')).toBe('renderHotView');
  });

  it('collapses synthetic arrow names to <arrow>', () => {
    const { displayName } = loadHelpers();
    expect(displayName('<arrow:packages/fitness/checks-universal/src/checks/resilience/transaction-patterns.ts:234:45>')).toBe('<arrow>');
    expect(displayName('<arrow:src/foo.ts:1:1>')).toBe('<arrow>');
  });

  it('collapses other synthetic shapes', () => {
    const { displayName } = loadHelpers();
    expect(displayName('<fn-expr:src/foo.ts:42:7>')).toBe('<fn-expr>');
    expect(displayName('<module-init:src/foo.ts>')).toBe('<module-init>');
    expect(displayName('<default>')).toBe('<default>');
  });

  it('returns empty string for non-string input', () => {
    const { displayName } = loadHelpers();
    expect(displayName(undefined as unknown as string)).toBe('');
  });
});
