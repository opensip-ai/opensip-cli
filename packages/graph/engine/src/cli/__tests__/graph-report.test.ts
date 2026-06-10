/**
 * Unified human-readable graph report builders. These are pure functions
 * over a catalog + indexes + signals; `buildUnifiedReportLines` reads the
 * scope-bound rule list, so the tests run inside a graph-extended scope.
 */

import { tmpdir } from 'node:os';

import { runWithScope, runWithScopeSync } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { buildLiveGraphOutput, buildUnifiedReportLines, resolutionBannerText } from '../graph-report.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';
import type { Signal } from '@opensip-tools/core';

function occ(over: Partial<FunctionOccurrence> = {}): FunctionOccurrence {
  return {
    bodyHash: 'h1',
    simpleName: 'main',
    qualifiedName: 'src/index.main',
    filePath: 'src/index.ts',
    line: 4,
    column: 0,
    endLine: 10,
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

function catalogOf(occs: readonly FunctionOccurrence[], resolutionMode?: 'exact' | 'fast'): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode,
    functions,
  };
}

function signal(over: Partial<Signal> = {}): Signal {
  return {
    ruleId: 'graph:orphan-subtree',
    message: 'orphaned',
    severity: 'medium',
    filePath: 'src/index.ts',
    line: 4,
    // `metadata` is part of the Signal contract (createSignal always sets it);
    // include it so the suppression chokepoint's graphLocate can read it.
    metadata: {},
    code: { file: 'src/index.ts', line: 4 },
    ...over,
  } as Signal;
}

describe('buildUnifiedReportLines', () => {
  it('renders catalog, findings-by-rule, enriched entry points, and summary', () => {
    const catalog = catalogOf([occ()]);
    const indexes = buildIndexes(catalog);
    const lines = runWithScopeSync(makeGraphTestScope(), () =>
      buildUnifiedReportLines(
        { catalog, indexes, signals: [signal()], cacheHit: true },
        { includeSummary: true },
      ),
    );
    const text = lines.join('\n');
    expect(text).toContain('== Catalog ==');
    expect(text).toContain('1 functions across 1 files (cacheHit=true)');
    expect(text).toContain('== Findings (1) ==');
    expect(text).toContain('src/index.ts:4 — orphaned');
    // The exported, uncalled `main` is inferred as an entry point and enriched.
    expect(text).toContain('== Entry points');
    expect(text).toContain('src/index.main');
    expect(text).toContain('== Summary ==');
  });

  it('renders the fast-mode approximation banner in the catalog section', () => {
    const catalog = catalogOf([occ()], 'fast');
    const indexes = buildIndexes(catalog);
    const lines = runWithScopeSync(makeGraphTestScope(), () =>
      buildUnifiedReportLines({ catalog, indexes, signals: [], cacheHit: false }),
    );
    expect(lines.join('\n')).toContain('Resolution: fast (syntactic)');
  });

  it('reports "(none inferred)" when there are no entry points', () => {
    // A non-exported, module-local function with a caller is not an entry point.
    const callee = occ({ bodyHash: 'h2', simpleName: 'helper', visibility: 'module-local' });
    const caller = occ({
      bodyHash: 'h1',
      simpleName: 'driver',
      visibility: 'module-local',
      calls: [{ to: ['h2'], line: 5, column: 1, resolution: 'static', confidence: 'high', text: 'helper()' }],
    });
    // driver is module-local + uncalled, so it would be... still not exported → not an entry point.
    const catalog = catalogOf([caller, callee]);
    const indexes = buildIndexes(catalog);
    const lines = runWithScopeSync(makeGraphTestScope(), () =>
      buildUnifiedReportLines({ catalog, indexes, signals: [], cacheHit: false }),
    );
    expect(lines.join('\n')).toContain('(none inferred)');
  });
});

describe('resolutionBannerText', () => {
  it('returns the fast-tier caveat only for fast mode', () => {
    expect(resolutionBannerText('fast')).toContain('Resolution: fast (syntactic)');
    expect(resolutionBannerText('exact')).toBeUndefined();
    expect(resolutionBannerText(undefined)).toBeUndefined();
  });
});

describe('buildLiveGraphOutput', () => {
  it('reduces a build to the slim { signals, suppressedCount, reportLines } payload (crossing the suppression seam)', async () => {
    const catalog = catalogOf([occ()]);
    const indexes = buildIndexes(catalog);
    const signals = [signal()];
    // tmpdir holds no `@graph-ignore` directive file for the signal's code.file,
    // so the suppression chokepoint reads ENOENT (non-fatal) and keeps the signal.
    const out = await runWithScope(makeGraphTestScope(), () =>
      buildLiveGraphOutput({ catalog, indexes, signals, cacheHit: true }, tmpdir()),
    );
    // The (unwaived) signal survives; no waivers applied here.
    expect(out.signals).toEqual(signals);
    expect(out.suppressedCount).toBe(0);
    // reportLines are pre-rendered WITHOUT the "== Summary ==" footer — RunSummary
    // renders that in the live view's place (includeSummary: false).
    const text = out.reportLines.join('\n');
    expect(text).toContain('== Catalog ==');
    expect(text).toContain('== Findings (1) ==');
    expect(text).not.toContain('== Summary ==');
  });
});
