/**
 * scope-abi — the `@opensip-cli/core` scope ABI constant, its package.json
 * mirror (single-core guard reads a FOREIGN core's ABI from its manifest), and
 * the version-floor inference for cores that predate the manifest field.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  coreVersionImplementsScopeAbi1,
  SCOPE_ABI_MANIFEST_FIELD,
  SCOPE_ABI_MIN_CORE_VERSION,
  SCOPE_ABI_VERSION,
} from '../scope-abi.js';

describe('scope ABI manifest mirror', () => {
  it("core's package.json opensipScopeAbiVersion equals the source constant", () => {
    // Guard reads a foreign core's ABI from its package.json without importing
    // it, so the manifest field MUST track SCOPE_ABI_VERSION or the two drift.
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as Record<string, unknown>;
    expect(pkg[SCOPE_ABI_MANIFEST_FIELD]).toBe(SCOPE_ABI_VERSION);
  });
});

describe('coreVersionImplementsScopeAbi1', () => {
  it('accepts the floor release and anything above it', () => {
    expect(coreVersionImplementsScopeAbi1(SCOPE_ABI_MIN_CORE_VERSION)).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.1.11')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.1.15')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.1.18')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.2.0')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('1.0.0')).toBe(true);
  });

  it('rejects releases below the floor (pre-shared-ALS)', () => {
    expect(coreVersionImplementsScopeAbi1('0.1.10')).toBe(false);
    expect(coreVersionImplementsScopeAbi1('0.1.0')).toBe(false);
    expect(coreVersionImplementsScopeAbi1('0.0.0')).toBe(false);
  });

  it('strips prerelease/build metadata before comparing', () => {
    expect(coreVersionImplementsScopeAbi1('0.1.15-rc.1')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.1.11+build.7')).toBe(true);
    expect(coreVersionImplementsScopeAbi1('0.0.0-foreign')).toBe(false);
  });

  it('treats an unparseable version as below the floor (conservative)', () => {
    expect(coreVersionImplementsScopeAbi1('not-a-version')).toBe(false);
    expect(coreVersionImplementsScopeAbi1('0.1')).toBe(false);
    expect(coreVersionImplementsScopeAbi1('')).toBe(false);
  });
});
