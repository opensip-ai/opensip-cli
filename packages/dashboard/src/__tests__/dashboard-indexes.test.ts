/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Unit tests for the browser-side `buildIndexes` builder.
 *
 * `buildIndexes` now lives in the typed client bundle (L4) and is exposed as a
 * page global; the test loads the bundle and reads it off the eval scope, then
 * exercises the function against synthetic catalogs.
 */

import { describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

type BuildIndexesFn = (catalog: GraphCatalog | null) => {
  byBodyHash: Map<string, GraphFunctionOccurrence>;
  bySimpleName: Map<string, string[]>;
  callees: Map<string, string[]>;
  callers: Map<string, string[]>;
};

function loadBuildIndexes(): BuildIndexesFn {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(
    'var sessions = [];\n' + DASHBOARD_CLIENT_BUNDLE + '\nreturn buildIndexes;',
  );
  return factory() as BuildIndexesFn;
}

function occ(
  overrides: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string },
): GraphFunctionOccurrence {
  return {
    qualifiedName: overrides.simpleName,
    filePath: 'packages/x/src/x.ts',
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
    ...overrides,
  };
}

describe('buildIndexes (browser-side)', () => {
  it('returns empty maps for an empty catalog', () => {
    const buildIndexes = loadBuildIndexes();
    const empty: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {},
    };
    const idx = buildIndexes(empty);
    expect(idx.byBodyHash.size).toBe(0);
    expect(idx.bySimpleName.size).toBe(0);
    expect(idx.callees.size).toBe(0);
    expect(idx.callers.size).toBe(0);
  });

  it('returns empty maps for null', () => {
    const buildIndexes = loadBuildIndexes();
    const idx = buildIndexes(null);
    expect(idx.byBodyHash.size).toBe(0);
    expect(idx.callers.size).toBe(0);
  });

  it('builds byBodyHash, bySimpleName, callees, callers for a 5-function fixture', () => {
    const buildIndexes = loadBuildIndexes();
    // a → b, a → c, b → d, c → d, e isolated.
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          occ({
            bodyHash: 'ha',
            simpleName: 'a',
            calls: [
              {
                to: ['hb', 'hc'],
                line: 2,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'b(); c();',
              },
            ],
          }),
        ],
        b: [
          occ({
            bodyHash: 'hb',
            simpleName: 'b',
            calls: [
              {
                to: ['hd'],
                line: 2,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'd();',
              },
            ],
          }),
        ],
        c: [
          occ({
            bodyHash: 'hc',
            simpleName: 'c',
            calls: [
              {
                to: ['hd'],
                line: 2,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'd();',
              },
            ],
          }),
        ],
        d: [occ({ bodyHash: 'hd', simpleName: 'd' })],
        e: [occ({ bodyHash: 'he', simpleName: 'e' })],
      },
    };
    const idx = buildIndexes(cat);
    expect(idx.byBodyHash.size).toBe(5);
    expect(idx.byBodyHash.get('ha')?.simpleName).toBe('a');
    expect(idx.bySimpleName.get('a')).toEqual(['ha']);
    expect(idx.callees.get('ha')).toEqual(['hb', 'hc']);
    expect(idx.callees.get('hb')).toEqual(['hd']);
    expect(idx.callees.has('he')).toBe(false);
    expect(idx.callers.get('hd')).toEqual(['hb', 'hc']);
    expect(idx.callers.get('hb')).toEqual(['ha']);
    expect(idx.callers.has('he')).toBe(false);
  });

  it('produces multiple caller entries for a single polymorphic CallEdge.to', () => {
    const buildIndexes = loadBuildIndexes();
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        f: [
          occ({
            bodyHash: 'hf',
            simpleName: 'f',
            calls: [
              {
                to: ['ht1', 'ht2', 'ht3'],
                line: 3,
                column: 0,
                resolution: 'method-dispatch',
                confidence: 'medium',
                text: 'x.foo()',
              },
            ],
          }),
        ],
        t1: [occ({ bodyHash: 'ht1', simpleName: 't1' })],
        t2: [occ({ bodyHash: 'ht2', simpleName: 't2' })],
        t3: [occ({ bodyHash: 'ht3', simpleName: 't3' })],
      },
    };
    const idx = buildIndexes(cat);
    expect(idx.callees.get('hf')).toEqual(['ht1', 'ht2', 'ht3']);
    expect(idx.callers.get('ht1')).toEqual(['hf']);
    expect(idx.callers.get('ht2')).toEqual(['hf']);
    expect(idx.callers.get('ht3')).toEqual(['hf']);
  });

  it('drops edges whose target is not in the catalog', () => {
    const buildIndexes = loadBuildIndexes();
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          occ({
            bodyHash: 'ha',
            simpleName: 'a',
            calls: [
              {
                to: ['external-hash-not-in-catalog'],
                line: 1,
                column: 0,
                resolution: 'unknown',
                confidence: 'low',
                text: 'external()',
              },
            ],
          }),
        ],
      },
    };
    const idx = buildIndexes(cat);
    expect(idx.callees.has('ha')).toBe(false);
    expect(idx.callers.size).toBe(0);
  });

  it('groups multiple occurrences under the same simpleName', () => {
    const buildIndexes = loadBuildIndexes();
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        format: [
          occ({ bodyHash: 'h1', simpleName: 'format' }),
          occ({ bodyHash: 'h2', simpleName: 'format', filePath: 'packages/y/src/y.ts' }),
        ],
      },
    };
    const idx = buildIndexes(cat);
    expect(idx.bySimpleName.get('format')).toEqual(['h1', 'h2']);
  });
});
