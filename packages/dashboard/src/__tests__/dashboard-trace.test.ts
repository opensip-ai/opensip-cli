/**
 * `traceFromEntry` BFS tests.
 */

import { describe, expect, it } from 'vitest';

import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardTraceJs } from '../code-paths/trace.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

interface Env {
  buildIndexes: (cat: GraphCatalog | null) => {
    byBodyHash: Map<string, GraphFunctionOccurrence>;
    callees: Map<string, string[]>;
    callers: Map<string, string[]>;
  };
  traceFromEntry: (target: string, cat: GraphCatalog, idx: unknown) => string[] | null;
}

function loadEnv(): Env {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const fn = new Function(
    dashboardIndexesJs() + dashboardTraceJs() + '\nreturn { buildIndexes, traceFromEntry };',
  )();
  return fn as Env;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
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
    ...over,
  };
}

describe('traceFromEntry', () => {
  it('finds the shortest path from an entry to the target', () => {
    const env = loadEnv();
    // entry (cli) → mid → target. Plus a longer path entry → a → b → mid.
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        entry: [
          makeOcc({
            bodyHash: 'he',
            simpleName: 'entry',
            filePath: 'packages/cli/src/index.ts',
            calls: [
              {
                to: ['hm', 'ha'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: '...',
              },
            ],
          }),
        ],
        a: [
          makeOcc({
            bodyHash: 'ha',
            simpleName: 'a',
            calls: [
              {
                to: ['hb'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'b()',
              },
            ],
          }),
        ],
        b: [
          makeOcc({
            bodyHash: 'hb',
            simpleName: 'b',
            calls: [
              {
                to: ['hm'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'mid()',
              },
            ],
          }),
        ],
        mid: [
          makeOcc({
            bodyHash: 'hm',
            simpleName: 'mid',
            calls: [
              {
                to: ['ht'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        target: [makeOcc({ bodyHash: 'ht', simpleName: 'target' })],
      },
    };
    const idx = env.buildIndexes(cat);
    const path = env.traceFromEntry('ht', cat, idx);
    expect(path).toEqual(['he', 'hm', 'ht']);
  });

  it('returns null when no entry reaches the target', () => {
    const env = loadEnv();
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        entry: [
          makeOcc({ bodyHash: 'he', simpleName: 'entry', filePath: 'packages/cli/src/index.ts' }),
        ],
        // 'orphan' has callers, so it's not an entry; nothing else points at it.
        target: [makeOcc({ bodyHash: 'ht', simpleName: 'target', visibility: 'module-local' })],
      },
    };
    const idx = env.buildIndexes(cat);
    const path = env.traceFromEntry('ht', cat, idx);
    expect(path).toBeNull();
  });

  it('returns null for an unknown target hash', () => {
    const env = loadEnv();
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        e: [makeOcc({ bodyHash: 'e', simpleName: 'e', filePath: 'packages/cli/src/index.ts' })],
      },
    };
    const idx = env.buildIndexes(cat);
    expect(env.traceFromEntry('nonexistent', cat, idx)).toBeNull();
  });
});
