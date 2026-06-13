/**
 * Type-shape lock for the catalog JSON wire format. Each test asserts
 * a sample object that exercises every documented field — a removal or
 * shape change in the types fails the assertion.
 *
 * Phase 3 Task 3.1 per DEC-498. Phase 5 (opensip-side ingestor) cites
 * these types as the wire contract.
 */

import { describe, expect, it } from 'vitest';

import type {
  CatalogExport,
  CatalogExportEdge,
  CatalogExportProvenance,
  CatalogExportSymbol,
} from '../../render/catalog-json-types.js';

describe('CatalogExport wire shape', () => {
  it('CatalogExportSymbol accepts all 14 documented fields', () => {
    const symbol: CatalogExportSymbol = {
      id: 'a'.repeat(64),
      repoId: 'repo_x',
      kind: 'function',
      language: 'typescript',
      qualifiedName: 'OrderProcessor.process',
      modulePath: 'src/order/process',
      arity: 2,
      filePath: 'src/order/process.ts',
      startLine: 42,
      endLine: 67,
      isExported: true,
      signature: '(order: Order, ctx: Context) => Result',
      docSummary: 'Processes a customer order through the fulfillment pipeline.',
      gitSha: 'abc1234567890abc1234567890abc1234567890a',
    };
    expect(symbol.id).toHaveLength(64);
    expect(symbol.arity).toBe(2);
  });

  it('CatalogExportSymbol accepts arity = null for symbols without arity', () => {
    const symbol: CatalogExportSymbol = {
      id: 'b'.repeat(64),
      repoId: 'repo_x',
      kind: 'class',
      language: 'typescript',
      qualifiedName: 'OrderProcessor',
      modulePath: 'src/order/process',
      arity: null,
      filePath: 'src/order/process.ts',
      startLine: 1,
      endLine: 100,
      isExported: true,
      gitSha: 'abc1234567890abc1234567890abc1234567890a',
    };
    expect(symbol.arity).toBeNull();
  });

  it('CatalogExportEdge accepts a resolved edge with toSymbolId', () => {
    const edge: CatalogExportEdge = {
      id: 'c'.repeat(64),
      repoId: 'repo_x',
      edgeKind: 'calls',
      fromSymbolId: 'a'.repeat(64),
      toSymbolId: 'b'.repeat(64),
      toQualifiedNameUnresolved: null,
      sourceFile: 'src/order/process.ts',
      sourceLine: 47,
      gitSha: 'abc1234567890abc1234567890abc1234567890a',
    };
    expect(edge.toSymbolId).toBeTruthy();
    expect(edge.toQualifiedNameUnresolved).toBeNull();
  });

  it('CatalogExportEdge accepts an unresolved edge with toQualifiedNameUnresolved', () => {
    const edge: CatalogExportEdge = {
      id: 'd'.repeat(64),
      repoId: 'repo_x',
      edgeKind: 'calls',
      fromSymbolId: 'a'.repeat(64),
      toSymbolId: null,
      toQualifiedNameUnresolved: 'externalLib.someFn',
      sourceFile: 'src/order/process.ts',
      sourceLine: 48,
      gitSha: 'abc1234567890abc1234567890abc1234567890a',
    };
    expect(edge.toSymbolId).toBeNull();
    expect(edge.toQualifiedNameUnresolved).toBe('externalLib.someFn');
  });

  it('CatalogExportProvenance complete shape', () => {
    const p: CatalogExportProvenance = {
      runId: '01j-test-run-id-uuid',
      completeness: 'complete',
      engineVersion: '1.0.0',
      startedAt: '2026-05-27T00:00:00.000Z',
      completedAt: '2026-05-27T00:01:00.000Z',
      tenantId: 'tenant_x',
    };
    expect(p.completeness).toBe('complete');
    expect(p.completedAt).not.toBeNull();
  });

  it('CatalogExportProvenance partial shape allows null completedAt', () => {
    const p: CatalogExportProvenance = {
      runId: '01j-test-run-id-uuid',
      completeness: 'partial',
      engineVersion: '1.0.0',
      startedAt: '2026-05-27T00:00:00.000Z',
      completedAt: null,
      tenantId: 'tenant_x',
    };
    expect(p.completeness).toBe('partial');
    expect(p.completedAt).toBeNull();
  });

  it('CatalogExport top-level document', () => {
    const doc: CatalogExport = {
      version: '1.0',
      provenance: {
        runId: 'run_x',
        completeness: 'complete',
        engineVersion: '1.0.0',
        startedAt: '2026-05-27T00:00:00.000Z',
        completedAt: '2026-05-27T00:01:00.000Z',
        tenantId: 'tenant_x',
      },
      symbols: [],
      edges: [],
    };
    expect(doc.version).toBe('1.0');
    expect(doc.symbols).toEqual([]);
    expect(doc.edges).toEqual([]);
  });
});
