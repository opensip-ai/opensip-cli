/**
 * Tests for the catalog JSON renderer.
 *
 * Coverage:
 *   1. Golden-fixture snapshot of a small representative catalog —
 *      locks the wire format byte-for-byte.
 *   2. Symbol-row invariants: id matches `deriveOpenSipSymbolId`
 *      output, kind mapping, arity derivation, modulePath
 *      derivation, isExported from visibility.
 *   3. Edge-row invariants: id matches `deriveOpenSipEdgeId`,
 *      polymorphic edges split into multiple rows, unresolved edges
 *      carry the call-text as `toQualifiedNameUnresolved`.
 *   4. Stable ordering: re-rendering the same catalog produces
 *      byte-identical output.
 *
 * Phase 3 Task 3.3 per DEC-498.
 */

import { describe, expect, it } from 'vitest';

import { renderCatalogJson } from '../../render/catalog-json.js';
import {
  deriveOpenSipEdgeId,
  deriveOpenSipModulePath,
  deriveOpenSipSymbolId,
} from '../../render/opensip-id-derivation.js';

import type { CatalogExportProvenance } from '../../render/catalog-json-types.js';
import type { CallEdge, Catalog, FunctionOccurrence, Indexes } from '../../types.js';

const REPO_ID = 'REP_test_repo';
const GIT_SHA = 'abc1234567890abc1234567890abc1234567890a';
const TENANT_ID = 'tenant_test';

function makeProvenance(): CatalogExportProvenance {
  return {
    runId: 'run_test_2026_05_27',
    completeness: 'complete',
    engineVersion: '1.0.0',
    startedAt: '2026-05-27T00:00:00.000Z',
    completedAt: '2026-05-27T00:01:00.000Z',
    tenantId: TENANT_ID,
  };
}

const FORMAT_NAME_OCCURRENCE: FunctionOccurrence = {
  bodyHash: 'hash_format_name',
  simpleName: 'formatName',
  qualifiedName: 'src/format.formatName',
  filePath: 'src/format.ts',
  line: 10,
  column: 0,
  endLine: 15,
  kind: 'function-declaration',
  params: [{ name: 'raw', optional: false, rest: false }],
  returnType: 'string',
  enclosingClass: null,
  decorators: [],
  visibility: 'exported',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
};

const GREET_OCCURRENCE: FunctionOccurrence = {
  bodyHash: 'hash_greet',
  simpleName: 'greet',
  qualifiedName: 'src/greet.greet',
  filePath: 'src/greet.ts',
  line: 5,
  column: 0,
  endLine: 12,
  kind: 'function-declaration',
  params: [],
  returnType: 'void',
  enclosingClass: null,
  decorators: [],
  visibility: 'module-local',
  inTestFile: false,
  definedInGenerated: false,
  calls: [
    // Resolved call: greet → formatName
    {
      to: ['hash_format_name'],
      line: 7,
      column: 2,
      resolution: 'static',
      confidence: 'high',
      text: 'formatName(rawName)',
    } satisfies CallEdge,
    // Unresolved call: external function
    {
      to: [],
      line: 8,
      column: 2,
      resolution: 'unknown',
      confidence: 'low',
      text: 'externalLib.log("hi")',
    } satisfies CallEdge,
  ],
};

const FIXTURE_CATALOG: Catalog = {
  version: '3.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-05-27T00:00:00.000Z',
  cacheKey: 'ts-5.7.0-test',
  filesFingerprint: 'test-fp',
  functions: {
    greet: [GREET_OCCURRENCE],
    formatName: [FORMAT_NAME_OCCURRENCE],
  },
};

const FIXTURE_INDEXES: Indexes = {
  byBodyHash: new Map([
    ['hash_greet', GREET_OCCURRENCE],
    ['hash_format_name', FORMAT_NAME_OCCURRENCE],
  ]),
  byOccId: new Map(),
  occurrencesByHash: new Map([
    ['hash_greet', [GREET_OCCURRENCE]],
    ['hash_format_name', [FORMAT_NAME_OCCURRENCE]],
  ]),
  importedPackagesByFile: new Map(),
  bySimpleName: new Map([
    ['greet', ['hash_greet']],
    ['formatName', ['hash_format_name']],
  ]),
  callees: new Map(),
  callers: new Map(),
};

describe('renderCatalogJson — golden fixture', () => {
  it('matches the recorded shape for the test catalog', async () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    await expect(json).toMatchFileSnapshot('./__fixtures__/catalog-json/two-functions.json');
  });
});

describe('renderCatalogJson — symbol rows', () => {
  it('every symbol id matches deriveOpenSipSymbolId output', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      symbols: {
        id: string;
        modulePath: string;
        kind: string;
        qualifiedName: string;
        arity: number | null;
      }[];
    };
    for (const sym of parsed.symbols) {
      const expected = deriveOpenSipSymbolId({
        repoId: REPO_ID,
        modulePath: sym.modulePath,
        kind: sym.kind,
        qualifiedName: sym.qualifiedName,
        arity: sym.arity,
      });
      expect(sym.id).toBe(expected);
    }
  });

  it('modulePath strips the .ts extension', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      symbols: { modulePath: string; filePath: string }[];
    };
    for (const sym of parsed.symbols) {
      expect(sym.modulePath).toBe(deriveOpenSipModulePath(sym.filePath));
      expect(sym.modulePath.endsWith('.ts')).toBe(false);
    }
  });

  it('arity is derived from params.length', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      symbols: { qualifiedName: string; arity: number | null }[];
    };
    const greet = parsed.symbols.find((s) => s.qualifiedName === 'src/greet.greet');
    const formatName = parsed.symbols.find((s) => s.qualifiedName === 'src/format.formatName');
    expect(greet?.arity).toBe(0);
    expect(formatName?.arity).toBe(1);
  });

  it('isExported reflects FunctionOccurrence.visibility', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      symbols: { qualifiedName: string; isExported: boolean }[];
    };
    const greet = parsed.symbols.find((s) => s.qualifiedName === 'src/greet.greet');
    const formatName = parsed.symbols.find((s) => s.qualifiedName === 'src/format.formatName');
    expect(greet?.isExported).toBe(false); // visibility: 'module-local'
    expect(formatName?.isExported).toBe(true); // visibility: 'exported'
  });
});

describe('renderCatalogJson — edge rows', () => {
  it('emits one resolved + one unresolved edge from the greet occurrence', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      edges: {
        edgeKind: string;
        fromSymbolId: string;
        toSymbolId: string | null;
        toQualifiedNameUnresolved: string | null;
        sourceLine: number | null;
      }[];
    };
    expect(parsed.edges).toHaveLength(2);

    const resolved = parsed.edges.find((e) => e.toSymbolId !== null);
    const unresolved = parsed.edges.find((e) => e.toSymbolId === null);

    expect(resolved?.edgeKind).toBe('calls');
    expect(resolved?.sourceLine).toBe(7);
    expect(unresolved?.toQualifiedNameUnresolved).toBe('externalLib.log("hi")');
    expect(unresolved?.sourceLine).toBe(8);
  });

  it('every edge id matches deriveOpenSipEdgeId output', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      edges: {
        id: string;
        edgeKind: string;
        fromSymbolId: string;
        toSymbolId: string | null;
        toQualifiedNameUnresolved: string | null;
      }[];
    };
    for (const edge of parsed.edges) {
      const expected = deriveOpenSipEdgeId({
        fromSymbolId: edge.fromSymbolId,
        edgeKind: edge.edgeKind,
        toSymbolId: edge.toSymbolId,
        toQualifiedNameUnresolved: edge.toQualifiedNameUnresolved,
      });
      expect(edge.id).toBe(expected);
    }
  });
});

describe('renderCatalogJson — invariants', () => {
  it('output is byte-identical across two renders of the same input', () => {
    const a = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const b = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    expect(a).toBe(b);
  });

  it('provenance.tenantId is preserved verbatim', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as { provenance: { tenantId: string } };
    expect(parsed.provenance.tenantId).toBe(TENANT_ID);
  });

  it('every row carries the input repoId + gitSha', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      symbols: { repoId: string; gitSha: string }[];
      edges: { repoId: string; gitSha: string }[];
    };
    for (const sym of parsed.symbols) {
      expect(sym.repoId).toBe(REPO_ID);
      expect(sym.gitSha).toBe(GIT_SHA);
    }
    for (const edge of parsed.edges) {
      expect(edge.repoId).toBe(REPO_ID);
      expect(edge.gitSha).toBe(GIT_SHA);
    }
  });

  it('version is "1.0"', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as { version: string };
    expect(parsed.version).toBe('1.0');
  });
});

// ── Phase 4 (DEC-498) — dependency edges ──────────────────────────────

const FORMAT_MODULE_INIT: FunctionOccurrence = {
  bodyHash: 'hash_module_init_format',
  simpleName: '<module-init:src/format.ts>',
  qualifiedName: '<module-init:src/format>',
  filePath: 'src/format.ts',
  line: 1,
  column: 0,
  endLine: 20,
  kind: 'module-init',
  params: [],
  returnType: null,
  enclosingClass: null,
  decorators: [],
  visibility: 'module-local',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
};

const GREET_MODULE_INIT: FunctionOccurrence = {
  bodyHash: 'hash_module_init_greet',
  simpleName: '<module-init:src/greet.ts>',
  qualifiedName: '<module-init:src/greet>',
  filePath: 'src/greet.ts',
  line: 1,
  column: 0,
  endLine: 15,
  kind: 'module-init',
  params: [],
  returnType: null,
  enclosingClass: null,
  decorators: [],
  visibility: 'module-local',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
  dependencies: [
    // Resolved internal import: greet → format
    {
      to: ['hash_module_init_format'],
      line: 2,
      column: 0,
      specifier: './format.js',
    },
    // Unresolved external import: greet → external pkg
    {
      to: [],
      line: 3,
      column: 0,
      specifier: '@opensip/core',
    },
  ],
};

const FIXTURE_CATALOG_WITH_DEPS: Catalog = {
  version: '3.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-05-27T00:00:00.000Z',
  cacheKey: 'ts-5.7.0-test',
  filesFingerprint: 'test-fp-deps',
  functions: {
    '<module-init:src/format.ts>': [FORMAT_MODULE_INIT],
    '<module-init:src/greet.ts>': [GREET_MODULE_INIT],
  },
};

const FIXTURE_INDEXES_WITH_DEPS: Indexes = {
  byBodyHash: new Map([
    ['hash_module_init_format', FORMAT_MODULE_INIT],
    ['hash_module_init_greet', GREET_MODULE_INIT],
  ]),
  byOccId: new Map(),
  occurrencesByHash: new Map([
    ['hash_module_init_format', [FORMAT_MODULE_INIT]],
    ['hash_module_init_greet', [GREET_MODULE_INIT]],
  ]),
  importedPackagesByFile: new Map(),
  bySimpleName: new Map(),
  callees: new Map(),
  callers: new Map(),
};

describe('renderCatalogJson — dependency edges (Phase 4)', () => {
  it('emits one resolved + one unresolved depends_on edge from greet module-init', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG_WITH_DEPS,
      indexes: FIXTURE_INDEXES_WITH_DEPS,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      edges: {
        edgeKind: string;
        fromSymbolId: string;
        toSymbolId: string | null;
        toQualifiedNameUnresolved: string | null;
        sourceFile: string;
        sourceLine: number | null;
      }[];
    };
    const dependsEdges = parsed.edges.filter((e) => e.edgeKind === 'depends_on');
    expect(dependsEdges).toHaveLength(2);

    const resolved = dependsEdges.find((e) => e.toSymbolId !== null);
    const unresolved = dependsEdges.find((e) => e.toSymbolId === null);

    expect(resolved?.sourceFile).toBe('src/greet.ts');
    expect(resolved?.sourceLine).toBe(2);
    expect(resolved?.toQualifiedNameUnresolved).toBeNull();

    expect(unresolved?.toQualifiedNameUnresolved).toBe('@opensip/core');
    expect(unresolved?.sourceLine).toBe(3);
  });

  it('depends_on edge id matches deriveOpenSipEdgeId', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG_WITH_DEPS,
      indexes: FIXTURE_INDEXES_WITH_DEPS,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as {
      edges: {
        id: string;
        edgeKind: string;
        fromSymbolId: string;
        toSymbolId: string | null;
        toQualifiedNameUnresolved: string | null;
      }[];
    };
    for (const edge of parsed.edges.filter((e) => e.edgeKind === 'depends_on')) {
      const expected = deriveOpenSipEdgeId({
        fromSymbolId: edge.fromSymbolId,
        edgeKind: edge.edgeKind,
        toSymbolId: edge.toSymbolId,
        toQualifiedNameUnresolved: edge.toQualifiedNameUnresolved,
      });
      expect(edge.id).toBe(expected);
    }
  });

  it('occurrence without dependencies field produces no depends_on edges', () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG,
      indexes: FIXTURE_INDEXES,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    const parsed = JSON.parse(json) as { edges: { edgeKind: string }[] };
    const dependsEdges = parsed.edges.filter((e) => e.edgeKind === 'depends_on');
    expect(dependsEdges).toHaveLength(0);
  });

  it('depends_on golden fixture lock', async () => {
    const json = renderCatalogJson({
      catalog: FIXTURE_CATALOG_WITH_DEPS,
      indexes: FIXTURE_INDEXES_WITH_DEPS,
      provenance: makeProvenance(),
      repoId: REPO_ID,
      gitSha: GIT_SHA,
    });
    await expect(json).toMatchFileSnapshot(
      './__fixtures__/catalog-json/two-modules-with-deps.json',
    );
  });
});
