/**
 * Catalog-JSON renderer — maps the engine catalog to a CatalogExport wire
 * document. Covers the FunctionKind → opensip-kind mapping for every
 * branch (function/method/getter/setter/constructor/module-init) and the
 * dangling-edge invariant skip (a call/dependency `to` hash absent from
 * the catalog is dropped rather than emitted half-formed).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { renderCatalogJson } from '../catalog-json.js';

import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  FunctionKind,
  FunctionOccurrence,
} from '../../types.js';
import type { CatalogExport } from '../catalog-json-types.js';

function occ(
  simpleName: string,
  bodyHash: string,
  kind: FunctionKind,
  calls: readonly CallEdge[] = [],
  dependencies?: readonly DependencyEdge[],
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `src/a.${simpleName}`,
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 2,
    kind,
    params: [],
    returnType: null,
    enclosingClass: kind === 'method' || kind === 'getter' || kind === 'setter' ? 'C' : null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls,
    ...(dependencies ? { dependencies } : {}),
  };
}

function catalogOf(occs: readonly FunctionOccurrence[]): Catalog {
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
    resolutionMode: 'exact',
    functions,
  };
}

const provenance = {
  runId: 'run-1',
  completeness: 'complete' as const,
  engineVersion: '2.0.0',
  startedAt: '2026-06-01T00:00:00.000Z',
  completedAt: '2026-06-01T00:00:01.000Z',
  tenantId: 't1',
};

function render(catalog: Catalog): CatalogExport {
  const json = renderCatalogJson({
    catalog,
    indexes: buildIndexes(catalog),
    provenance,
    repoId: 'r1',
    gitSha: 'sha1',
  });
  return JSON.parse(json) as CatalogExport;
}

describe('renderCatalogJson kind mapping', () => {
  it('maps every FunctionKind to its opensip kind convention', () => {
    const catalog = catalogOf([
      occ('fnDecl', 'h1', 'function-declaration'),
      occ('fnExpr', 'h2', 'function-expression'),
      occ('arrowFn', 'h3', 'arrow'),
      occ('meth', 'h4', 'method'),
      occ('get', 'h5', 'getter'),
      occ('set', 'h6', 'setter'),
      occ('ctor', 'h7', 'constructor'),
      occ('moduleInit', 'h8', 'module-init'),
    ]);
    const doc = render(catalog);
    // CatalogExportSymbol carries qualifiedName (`src/a.<simpleName>`), not simpleName.
    const kindByName = new Map(
      doc.symbols.map((s) => [s.qualifiedName.replace('src/a.', ''), s.kind]),
    );
    expect(kindByName.get('fnDecl')).toBe('function');
    expect(kindByName.get('fnExpr')).toBe('function');
    expect(kindByName.get('arrowFn')).toBe('function');
    expect(kindByName.get('meth')).toBe('method');
    expect(kindByName.get('get')).toBe('method');
    expect(kindByName.get('set')).toBe('method');
    expect(kindByName.get('ctor')).toBe('constructor');
    expect(kindByName.get('moduleInit')).toBe('module-init');
  });
});

describe('renderCatalogJson edge invariants', () => {
  it('emits a resolved call edge and drops one whose target hash is unknown', () => {
    const resolved: CallEdge = {
      to: ['h2'], line: 3, column: 1, resolution: 'static', confidence: 'high', text: 'b()',
    };
    const dangling: CallEdge = {
      to: ['NOPE'], line: 4, column: 1, resolution: 'static', confidence: 'high', text: 'gone()',
    };
    const catalog = catalogOf([
      occ('a', 'h1', 'function-declaration', [resolved, dangling]),
      occ('b', 'h2', 'function-declaration'),
    ]);
    const doc = render(catalog);
    // Exactly one edge survived — the resolved one; the dangling NOPE was skipped.
    expect(doc.edges).toHaveLength(1);
  });

  it('drops a dependency edge whose target hash is unknown', () => {
    const dep: DependencyEdge = {
      to: ['MISSING'], specifier: 'x', line: 1, column: 0,
    };
    const catalog = catalogOf([occ('mod', 'h1', 'module-init', [], [dep])]);
    const doc = render(catalog);
    expect(doc.edges).toHaveLength(0);
  });
});
