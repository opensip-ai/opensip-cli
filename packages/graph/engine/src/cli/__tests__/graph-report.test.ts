/**
 * Unified human-readable graph report builders. These are pure functions
 * over a catalog + indexes + signals; `buildUnifiedReportLines` reads the
 * scope-bound rule list, so the tests run inside a graph-extended scope.
 */

import { runWithScopeSync } from '@opensip-tools/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import {
  buildUnifiedReportLines,
  writeFooterHintsPlain,
  writeResolutionBannerPlain,
  writeRunSummaryPlain,
  writeUnifiedReport,
} from '../graph-report.js';

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
    ...over,
  } as Signal;
}

function captureStdout(fn: () => void): string {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    buf += typeof c === 'string' ? c : c.toString();
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return buf;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('writeUnifiedReport', () => {
  it('writes the report to stdout prefixed with the tool banner', () => {
    const catalog = catalogOf([occ()]);
    const indexes = buildIndexes(catalog);
    const out = runWithScopeSync(makeGraphTestScope(), () =>
      captureStdout(() => writeUnifiedReport({ catalog, indexes, signals: [], cacheHit: false })),
    );
    expect(out.startsWith('opensip-tools graph')).toBe(true);
  });
});

describe('plain-text writers', () => {
  it('writeRunSummaryPlain renders the one-line PASS/FAIL summary', () => {
    const out = captureStdout(() =>
      writeRunSummaryPlain({ passed: 3, failed: 1, errors: 1, warnings: 2, durationMs: 1000 }),
    );
    expect(out).toContain('3 Passed, 1 Failed (1 Errors, 2 Warnings)');
    expect(out).toContain('Duration');
  });

  it('writeResolutionBannerPlain emits only for fast mode', () => {
    expect(captureStdout(() => writeResolutionBannerPlain('fast'))).toContain('Resolution: fast');
    expect(captureStdout(() => writeResolutionBannerPlain('exact'))).toBe('');
    expect(captureStdout(() => writeResolutionBannerPlain(undefined))).toBe('');
  });

  it('writeFooterHintsPlain emits the hint strip', () => {
    expect(captureStdout(() => writeFooterHintsPlain())).toContain('Use --verbose for detailed results');
  });
});
