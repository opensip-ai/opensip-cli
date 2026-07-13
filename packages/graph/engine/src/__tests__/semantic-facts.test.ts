import { describe, expect, it } from 'vitest';

import {
  applySemanticFactCaps,
  emptySemanticFactBundle,
  makeDeclarationId,
  makeReferenceId,
  mergeSemanticFactBundles,
  mergeSemanticFactsIncremental,
} from '../semantic-facts.js';

import type {
  CrossFileReferenceFact,
  DeclarationFact,
  SemanticFactBundle,
  SemanticFactLimits,
} from '../types.js';

const tinyLimits: SemanticFactLimits = {
  maxDeclarations: 2,
  maxReferences: 3,
  maxReferencesPerDeclaration: 2,
  maxName: 256,
  maxText: 1024,
  maxLine: 10_000_000,
  maxColumn: 1_000_000,
};

function decl(id: string, over: Partial<DeclarationFact> = {}): DeclarationFact {
  return {
    declarationId: id,
    name: over.name ?? id,
    qualifiedName: over.qualifiedName ?? `pkg/${id}`,
    kind: over.kind ?? 'interface',
    package: over.package ?? 'pkg',
    filePath: over.filePath ?? `src/${id}.ts`,
    line: over.line ?? 1,
    column: over.column ?? 0,
    endLine: over.endLine ?? 1,
    endColumn: over.endColumn ?? 5,
    visibility: over.visibility ?? 'exported',
    exportRole: over.exportRole ?? 'named-export',
    inTestFile: over.inTestFile ?? false,
    definedInGenerated: over.definedInGenerated ?? false,
  };
}

function ref(id: string, over: Partial<CrossFileReferenceFact> = {}): CrossFileReferenceFact {
  return {
    referenceId: id,
    kind: over.kind ?? 'type',
    filePath: over.filePath ?? 'src/use.ts',
    line: over.line ?? 2,
    column: over.column ?? 0,
    endLine: over.endLine ?? 2,
    endColumn: over.endColumn ?? 3,
    package: over.package ?? 'pkg',
    targetDeclarationId: over.targetDeclarationId,
    targetPackage: over.targetPackage,
    targetName: over.targetName,
    targetKind: over.targetKind,
    basis:
      over.basis ??
      (over.targetDeclarationId === undefined ? 'unresolved' : 'compiler-declaration'),
    confidence: over.confidence ?? 'high',
    reason: over.reason,
    importSpecifier: over.importSpecifier,
    inTestFile: over.inTestFile ?? false,
    definedInGenerated: over.definedInGenerated ?? false,
  };
}

describe('semantic fact identity', () => {
  it('builds stable declaration and reference ids', () => {
    const a = makeDeclarationId({
      package: 'pkg',
      filePath: 'src/a.ts',
      kind: 'interface',
      name: 'Foo',
      line: 1,
      column: 0,
    });
    const b = makeDeclarationId({
      package: 'pkg',
      filePath: 'src/a.ts',
      kind: 'interface',
      name: 'Foo',
      line: 1,
      column: 0,
    });
    expect(a).toBe(b);
    expect(a.startsWith('d1|')).toBe(true);
    expect(
      makeReferenceId({
        filePath: 'src/b.ts',
        kind: 'type',
        line: 3,
        column: 1,
        targetDeclarationId: a,
      }).startsWith('r1|'),
    ).toBe(true);
  });
});

describe('applySemanticFactCaps', () => {
  it('keeps present-empty bundles complete', () => {
    const empty = emptySemanticFactBundle();
    expect(empty.declarations).toEqual([]);
    expect(empty.references).toEqual([]);
    expect(empty.coverage.status).toBe('complete');
    expect(empty.referenceScope).toBe('cross-file');
  });

  it('caps declarations deterministically and never leaves dangling target ids', () => {
    // maxDeclarations=2 and modest-overflow budget = 2 + min(1000, 2) = 4, so
    // 5 total declarations exceeds even the closure-preserving overflow: the
    // hard-cap-and-downgrade path must fire and leave no dangling target ids.
    const d1 = decl('d-a', { name: 'A', filePath: 'src/a.ts', line: 1 });
    const d2 = decl('d-b', { name: 'B', filePath: 'src/b.ts', line: 1 });
    const d3 = decl('d-c', { name: 'C', filePath: 'src/c.ts', line: 1 });
    const d4 = decl('d-d', { name: 'D', filePath: 'src/d.ts', line: 1 });
    const d5 = decl('d-e', { name: 'E', filePath: 'src/e.ts', line: 1 });
    const r1 = ref('r-1', {
      targetDeclarationId: d3.declarationId,
      targetName: 'C',
      targetPackage: 'pkg',
      targetKind: 'interface',
    });
    const out = applySemanticFactCaps(
      [d1, d2, d3, d4, d5],
      [r1],
      {
        status: 'complete',
        inspectedDeclarations: 5,
        emittedDeclarations: 5,
        omittedDeclarations: 0,
        inspectedReferences: 1,
        emittedReferences: 1,
        omittedReferences: 0,
        reasons: [],
      },
      tinyLimits,
    );
    expect(out.declarations.length).toBeLessThanOrEqual(tinyLimits.maxDeclarations + 1000);
    for (const r of out.references) {
      if (r.targetDeclarationId !== undefined) {
        expect(out.declarations.some((d) => d.declarationId === r.targetDeclarationId)).toBe(true);
      }
    }
    expect(out.coverage.reasons.length).toBeGreaterThan(0);
  });

  it('preserves referential closure when a lone overflow declaration fits the modest-overflow budget', () => {
    // maxDeclarations=2, so d3 (sorted third) falls outside the primary top-K,
    // but r1 targets it and 3 <= maxDeclarations + min(1000, maxDeclarations)
    // (2 + 2 = 4), so the closure-preserving path should keep d3 and leave r1
    // resolved instead of downgrading it.
    const d1 = decl('d-a', { name: 'A', filePath: 'src/a.ts', line: 1 });
    const d2 = decl('d-b', { name: 'B', filePath: 'src/b.ts', line: 1 });
    const d3 = decl('d-c', { name: 'C', filePath: 'src/c.ts', line: 1 });
    const r1 = ref('r-1', {
      targetDeclarationId: d3.declarationId,
      targetName: 'C',
      targetPackage: 'pkg',
      targetKind: 'interface',
    });
    const out = applySemanticFactCaps(
      [d1, d2, d3],
      [r1],
      {
        status: 'complete',
        inspectedDeclarations: 3,
        emittedDeclarations: 3,
        omittedDeclarations: 0,
        inspectedReferences: 1,
        emittedReferences: 1,
        omittedReferences: 0,
        reasons: [],
      },
      tinyLimits,
    );
    expect(out.declarations.some((d) => d.declarationId === d3.declarationId)).toBe(true);
    expect(out.references[0]?.targetDeclarationId).toBe(d3.declarationId);
    expect(out.references[0]?.basis).not.toBe('unresolved');
  });

  it('enforces reference cap N/N+1', () => {
    const d = decl('d-a');
    const refs = [1, 2, 3, 4].map((i) =>
      ref(`r-${String(i)}`, {
        line: i,
        targetDeclarationId: d.declarationId,
        targetName: 'd-a',
        targetPackage: 'pkg',
        targetKind: 'interface',
      }),
    );
    const out = applySemanticFactCaps(
      [d],
      refs,
      {
        status: 'complete',
        inspectedDeclarations: 1,
        emittedDeclarations: 1,
        omittedDeclarations: 0,
        inspectedReferences: 4,
        emittedReferences: 4,
        omittedReferences: 0,
        reasons: [],
      },
      tinyLimits,
    );
    expect(out.references.length).toBeLessThanOrEqual(tinyLimits.maxReferences);
    expect(out.coverage.reasons).toContain('reference-cap');
  });
});

describe('mergeSemanticFactBundles', () => {
  it('returns undefined when all inputs are absent', () => {
    expect(mergeSemanticFactBundles([undefined, undefined])).toBeUndefined();
  });

  it('preserves present-empty when merging empty with empty', () => {
    const a = emptySemanticFactBundle();
    const b = emptySemanticFactBundle();
    const merged = mergeSemanticFactBundles([a, b]);
    expect(merged).toBeDefined();
    expect(merged!.declarations).toEqual([]);
    expect(merged!.references).toEqual([]);
  });

  it('dedupes by stable id', () => {
    const d = decl('same');
    const left: SemanticFactBundle = {
      referenceScope: 'cross-file',
      declarations: [d],
      references: [],
      coverage: emptySemanticFactBundle().coverage,
    };
    const right: SemanticFactBundle = {
      referenceScope: 'cross-file',
      declarations: [d],
      references: [],
      coverage: emptySemanticFactBundle().coverage,
    };
    const merged = mergeSemanticFactBundles([left, right])!;
    expect(merged.declarations).toHaveLength(1);
  });
});

describe('mergeSemanticFactsIncremental coverage does not compound (P2 Phase 3 regression)', () => {
  // The exact tier re-walks the WHOLE program each incremental run, so both the
  // cached and the fresh bundle carry whole-project coverage. Summing them would
  // double the inspected* counters every rebuild until they cross the validation
  // bound and permanently brick the catalog on read. The merged coverage must
  // instead track the fresh (authoritative) whole-project inspection.
  const wholeProject = (inspectedReferences: number): SemanticFactBundle => ({
    referenceScope: 'cross-file',
    declarations: [decl('a', { filePath: 'src/a.ts' })],
    references: [
      ref('r1', {
        filePath: 'src/a.ts',
        targetDeclarationId: 'a',
        targetPackage: 'pkg',
        targetName: 'a',
        targetKind: 'interface',
      }),
    ],
    coverage: {
      status: 'complete',
      inspectedDeclarations: 1,
      emittedDeclarations: 1,
      omittedDeclarations: 0,
      inspectedReferences,
      emittedReferences: 1,
      omittedReferences: 0,
      reasons: [],
    },
  });

  it('keeps inspected counts bounded across repeated whole-project incremental merges', () => {
    const closure = new Set(['src/a.ts']);
    const declFileById = new Map([['a', 'src/a.ts']]);

    const merged1 = mergeSemanticFactsIncremental(
      wholeProject(500),
      wholeProject(500),
      closure,
      declFileById,
    );
    // Fresh's 500, NOT the summed 1000.
    expect(merged1?.coverage.inspectedReferences).toBe(500);
    expect(merged1?.coverage.inspectedDeclarations).toBe(1);

    // Feed the merged result back as cached (the next incremental run) — the
    // counters must still not grow.
    const merged2 = mergeSemanticFactsIncremental(
      merged1,
      wholeProject(500),
      closure,
      declFileById,
    );
    expect(merged2?.coverage.inspectedReferences).toBe(500);
  });
});
