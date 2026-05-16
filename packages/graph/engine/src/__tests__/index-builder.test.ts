import { describe, expect, it } from 'vitest';

import { makeFunctionId } from '../catalog/ids.js';
import { buildIndexes } from '../catalog/index-builder.js';

import type { FunctionNode, CallSite } from '../catalog/types.js';

function fn(opts: {
  id: string;
  calls?: readonly CallSite[];
}): FunctionNode {
  return {
    id: opts.id,
    qualifiedName: opts.id,
    simpleName: opts.id.split('#')[1] ?? opts.id,
    filePath: 'src/x.ts',
    line: 1,
    column: 1,
    endLine: 5,
    kind: 'function',
    params: [],
    visibility: 'module-local',
    decorators: [],
    directSideEffects: null,
    inTestFile: false,
    definedInGenerated: false,
    calls: opts.calls ?? [],
  };
}

function call(opts: { resolvedTo: readonly string[]; resolution?: 'static' | 'method-dispatch' | 'unknown' | 'dynamic-string' }): CallSite {
  return {
    line: 2,
    column: 4,
    resolvedTo: opts.resolvedTo,
    resolution: opts.resolution ?? 'static',
    confidence: 'high',
    text: 'foo()',
  };
}

describe('buildIndexes', () => {
  it('groups functions by content hash', () => {
    const a = fn({ id: makeFunctionId({ contentHash: 'h1', filePath: 'a.ts', simpleName: 'foo' }) });
    const b = fn({ id: makeFunctionId({ contentHash: 'h1', filePath: 'b.ts', simpleName: 'foo' }) });
    const c = fn({ id: makeFunctionId({ contentHash: 'h2', filePath: 'c.ts', simpleName: 'bar' }) });
    const idx = buildIndexes([a, b, c]);
    expect(idx.byContentHash.get('h1')).toEqual([a.id, b.id]);
    expect(idx.byContentHash.get('h2')).toEqual([c.id]);
  });

  it('inverts the call edges into a callers index', () => {
    const target = fn({ id: makeFunctionId({ contentHash: 't', filePath: 't.ts', simpleName: 'target' }) });
    const caller = fn({
      id: makeFunctionId({ contentHash: 'c', filePath: 'c.ts', simpleName: 'caller' }),
      calls: [call({ resolvedTo: [target.id] })],
    });
    const idx = buildIndexes([target, caller]);
    expect(idx.callers.get(target.id)).toEqual([caller.id]);
  });

  it('treats polymorphic dispatch as a fan-out (each impl gets the caller)', () => {
    const impl1 = fn({ id: makeFunctionId({ contentHash: 'a', filePath: 'a.ts', simpleName: 'A.notify' }) });
    const impl2 = fn({ id: makeFunctionId({ contentHash: 'b', filePath: 'b.ts', simpleName: 'B.notify' }) });
    const dispatcher = fn({
      id: makeFunctionId({ contentHash: 'd', filePath: 'd.ts', simpleName: 'dispatch' }),
      calls: [call({ resolvedTo: [impl1.id, impl2.id], resolution: 'method-dispatch' })],
    });
    const idx = buildIndexes([impl1, impl2, dispatcher]);
    expect(idx.callers.get(impl1.id)).toEqual([dispatcher.id]);
    expect(idx.callers.get(impl2.id)).toEqual([dispatcher.id]);
  });

  it('deduplicates a caller that calls the same target multiple times', () => {
    const target = fn({ id: makeFunctionId({ contentHash: 't', filePath: 't.ts', simpleName: 'target' }) });
    const caller = fn({
      id: makeFunctionId({ contentHash: 'c', filePath: 'c.ts', simpleName: 'caller' }),
      calls: [
        call({ resolvedTo: [target.id] }),
        call({ resolvedTo: [target.id] }),
      ],
    });
    const idx = buildIndexes([target, caller]);
    expect(idx.callers.get(target.id)).toEqual([caller.id]);
  });

  it('returns empty indexes for an empty function list', () => {
    const idx = buildIndexes([]);
    expect([...idx.byContentHash]).toHaveLength(0);
    expect([...idx.callers]).toHaveLength(0);
  });
});
