import { describe, expect, it } from 'vitest';

import { evaluateDuplicatedFunctionBody } from '../analysis/rules/duplicated-function-body.js';
import { makeFunctionId } from '../catalog/ids.js';
import { buildIndexes } from '../catalog/index-builder.js';
import { CATALOG_LANGUAGE, CATALOG_TOOL, CATALOG_VERSION, type Catalog, type FunctionNode } from '../catalog/types.js';

function makeFn(opts: {
  contentHash: string;
  filePath: string;
  simpleName: string;
  endLine?: number;
}): FunctionNode {
  return {
    id: makeFunctionId({ contentHash: opts.contentHash, filePath: opts.filePath, simpleName: opts.simpleName }),
    qualifiedName: `${opts.filePath}.${opts.simpleName}`,
    simpleName: opts.simpleName,
    filePath: opts.filePath,
    line: 1,
    column: 1,
    endLine: opts.endLine ?? 5,
    kind: 'function',
    params: [],
    visibility: 'module-local',
    decorators: [],
    directSideEffects: null,
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

function catalogOf(fns: readonly FunctionNode[]): Catalog {
  return {
    version: CATALOG_VERSION,
    tool: CATALOG_TOOL,
    language: CATALOG_LANGUAGE,
    builtAt: '2026-05-15T00:00:00Z',
    tsConfigPath: '/example/tsconfig.json',
    tsCompilerVersion: '5.7.2',
    files: [],
    functions: fns,
    indexes: buildIndexes(fns),
  };
}

describe('graph:duplicated-function-body', () => {
  it('fires when two functions share a content hash', () => {
    const catalog = catalogOf([
      makeFn({ contentHash: 'h1', filePath: 'a.ts', simpleName: 'foo' }),
      makeFn({ contentHash: 'h1', filePath: 'b.ts', simpleName: 'bar' }),
    ]);
    const findings = evaluateDuplicatedFunctionBody(catalog);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('graph:duplicated-function-body');
    const m = findings[0].metadata as { duplicates: { id: string }[]; contentHash: string; confidence: string };
    expect(m.contentHash).toBe('h1');
    expect(m.duplicates).toHaveLength(2);
    expect(m.confidence).toBe('high');
  });

  it('does not fire on a single occurrence', () => {
    const catalog = catalogOf([
      makeFn({ contentHash: 'unique', filePath: 'a.ts', simpleName: 'foo' }),
    ]);
    expect(evaluateDuplicatedFunctionBody(catalog)).toEqual([]);
  });

  it('skips trivial single-line empty bodies', () => {
    const catalog = catalogOf([
      makeFn({ contentHash: 'empty', filePath: 'a.ts', simpleName: 'a', endLine: 1 }),
      makeFn({ contentHash: 'empty', filePath: 'b.ts', simpleName: 'b', endLine: 1 }),
    ]);
    expect(evaluateDuplicatedFunctionBody(catalog)).toEqual([]);
  });

  it('groups any number of duplicates into one finding per content hash', () => {
    const catalog = catalogOf([
      makeFn({ contentHash: 'h', filePath: 'a.ts', simpleName: 'a' }),
      makeFn({ contentHash: 'h', filePath: 'b.ts', simpleName: 'b' }),
      makeFn({ contentHash: 'h', filePath: 'c.ts', simpleName: 'c' }),
    ]);
    const findings = evaluateDuplicatedFunctionBody(catalog);
    expect(findings).toHaveLength(1);
    const m = findings[0].metadata as { duplicates: unknown[] };
    expect(m.duplicates).toHaveLength(3);
  });
});
