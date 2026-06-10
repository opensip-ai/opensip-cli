/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Filter chip predicate tests. Exercises the per-row `passesFilter`
 * predicate (per-view filter behavior is asserted in each view's
 * own test file; this file covers the predicate shape).
 */

import { describe, expect, it } from 'vitest';

import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';

import type { GraphFunctionOccurrence } from '@opensip-tools/contracts';

interface FilterEnv {
  passesFilter: (occ: GraphFunctionOccurrence, fs: FilterState) => boolean;
  packageOfPath: (p: string) => string;
}

interface FilterState {
  packages: Set<string>;
  kinds: Set<string>;
  includeTests: boolean;
}

function loadFilterEnv(): FilterEnv {
  // The filters/path-utils emitters expect `el(...)` and `views`/`graph*`
  // globals at runtime. The `passesFilter` and `packageOfPath` functions
  // we test here have no such dependency; we inject minimal shims.
  const stubs = `
function el(tag, attrs, children) { const e = document.createElement(tag); return e; }
const views = [];
let activeViewId = null;
let graphCatalog = null;
let graphIndexes = null;
`;
  const tail = `
return { passesFilter, packageOfPath };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(stubs + dashboardPathUtilsJs() + dashboardFiltersJs() + tail);
  return factory() as FilterEnv;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/contracts/src/x.ts',
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

describe('passesFilter (filter chip predicate)', () => {
  it('rejects test files by default (includeTests=false)', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', inTestFile: true });
    const fs: FilterState = { packages: new Set(), kinds: new Set(), includeTests: false };
    expect(env.passesFilter(occ, fs)).toBe(false);
  });

  it('accepts test files when includeTests=true', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', inTestFile: true });
    const fs: FilterState = { packages: new Set(), kinds: new Set(), includeTests: true };
    expect(env.passesFilter(occ, fs)).toBe(true);
  });

  it('rejects functions whose package is not in the active set (when set is non-empty)', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 'packages/cli/src/x.ts' });
    const fs: FilterState = {
      packages: new Set(['contracts']),
      kinds: new Set(),
      includeTests: false,
    };
    expect(env.passesFilter(occ, fs)).toBe(false);
  });

  it('accepts functions whose package is in the active set', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 'packages/cli/src/x.ts' });
    const fs: FilterState = { packages: new Set(['cli']), kinds: new Set(), includeTests: false };
    expect(env.passesFilter(occ, fs)).toBe(true);
  });

  it('rejects functions whose kind is not in the active kinds set', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', kind: 'arrow' });
    const fs: FilterState = {
      packages: new Set(),
      kinds: new Set(['method']),
      includeTests: false,
    };
    expect(env.passesFilter(occ, fs)).toBe(false);
  });

  it('empty packages set means "all allowed"', () => {
    const env = loadFilterEnv();
    const occ = makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 'packages/anywhere/src/x.ts' });
    const fs: FilterState = { packages: new Set(), kinds: new Set(), includeTests: false };
    expect(env.passesFilter(occ, fs)).toBe(true);
  });
});
