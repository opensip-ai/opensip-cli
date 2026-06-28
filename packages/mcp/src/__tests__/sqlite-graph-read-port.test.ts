/**
 * `SqliteGraphReadPort` against a REAL in-memory `DataStore` (Task 6.1 steps 2,
 * 4, 7 — ports return Result; persistence round-trip; generation snapshotting;
 * forward-compat; no raw body in DTOs).
 *
 * Seeds a hand-built catalog through the graph engine's `CatalogRepo` (the same
 * persistence path `runGraph` writes), then drives the port — no `runGraph`
 * needed at this level. A separate suite seeds NOTHING to assert the
 * missing-catalog ok-`fresh:false` contract.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { CatalogRepo } from '@opensip-cli/graph/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workingTreeContextFromCatalog } from '../freshness.js';
import { SqliteGraphReadPort } from '../sqlite-graph-read-port.js';

import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

const BUILT_AT = '2026-05-22T00:00:00.000Z';

/** A `FunctionOccurrence` with only the required fields set (pre-feature shape). */
function fnOcc(
  over: Partial<FunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
  },
): FunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: BUILT_AT,
    cacheKey: 'ts-5.7.3-test',
    filesFingerprint: '0\n',
    functions: {},
    ...over,
  };
}

/** caller→target plus two unreachable functions, for blast + dead-code + arch. */
function seededCatalog(builtAt = BUILT_AT): Catalog {
  return makeCatalog({
    builtAt,
    functions: {
      caller: [
        fnOcc({
          bodyHash: 'h-caller',
          simpleName: 'caller',
          filePath: 'src/caller.ts',
          line: 10,
          column: 2,
          endLine: 20,
          // `calls[].to` holds RESOLVED body hashes (post stage-2), not names.
          calls: [
            {
              to: ['h-target'],
              line: 12,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
          ],
        }),
      ],
      target: [fnOcc({ bodyHash: 'h-target', simpleName: 'target', filePath: 'src/target.ts' })],
      lonely1: [fnOcc({ bodyHash: 'h-l1', simpleName: 'lonely1', filePath: 'src/l1.ts' })],
      lonely2: [fnOcc({ bodyHash: 'h-l2', simpleName: 'lonely2', filePath: 'src/l2.ts' })],
    },
  });
}

let store: DataStore;

beforeEach(() => {
  store = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  store.close();
});

function seed(catalog: Catalog): void {
  new CatalogRepo(store).replaceAll(catalog);
}

describe('SqliteGraphReadPort — missing catalog', () => {
  it('reports getGeneration ok with fresh:false (missing) and no auto-build', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.getGeneration();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data).toBeUndefined();
      expect(out.value.freshness).toEqual({ fresh: false, reason: 'missing' });
    }
  });

  it('resolveSymbolId on a missing catalog is ok with undefined data (not an error)', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.resolveSymbolId('src/a.ts:1:0');
    expect(out.ok).toBe(true);
    expect(out.ok && out.value.data).toBeUndefined();
  });

  it('refresh without a rebuild provider returns a structured err', async () => {
    const port = new SqliteGraphReadPort({ store });
    const out = await port.refresh();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.code).toBe('refresh-unavailable');
  });
});

describe('SqliteGraphReadPort — seeded catalog reads', () => {
  beforeEach(() => seed(seededCatalog()));

  it('round-trips the catalog: getGeneration ok with the builtAt', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.getGeneration();
    expect(out.ok && out.value.data?.builtAt).toBe(BUILT_AT);
  });

  it('resolves a known symbolId to a metadata-only SymbolRef (bodyHash, never a raw body)', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.resolveSymbolId('src/caller.ts:10:2');
    expect(out.ok).toBe(true);
    const ref = out.ok ? out.value.data : undefined;
    expect(ref?.qualifiedName).toBe('caller');
    expect(ref?.bodyHash).toBe('h-caller');
    expect(ref).not.toHaveProperty('body');
    expect(ref).not.toHaveProperty('source');
    expect(ref).not.toHaveProperty('calls');
  });

  it('returns ok-undefined for an unknown symbolId', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.resolveSymbolId('src/nope.ts:99:9');
    expect(out.ok && out.value.data).toBeUndefined();
  });

  it('searches symbols by case-insensitive substring and applies the limit with truncated', () => {
    const port = new SqliteGraphReadPort({ store });
    const all = port.searchSymbols('lonely');
    expect(all.ok && all.value.data.map((r) => r.qualifiedName).sort()).toEqual([
      'lonely1',
      'lonely2',
    ]);
    const capped = port.searchSymbols('lonely', { limit: 1 });
    expect(capped.ok && capped.value.data).toHaveLength(1);
    expect(capped.ok && capped.value.truncated).toBe(true);
  });

  it('findBySpan returns the occurrence whose [line, endLine] span encloses the line', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.findBySpan('src/caller.ts', 15);
    expect(out.ok && out.value.data.map((r) => r.qualifiedName)).toEqual(['caller']);
    const none = port.findBySpan('src/caller.ts', 99);
    expect(none.ok && none.value.data).toHaveLength(0);
  });

  it('exposes caller/callee adjacency snapshots that resolve body hashes to SymbolRefs', () => {
    const port = new SqliteGraphReadPort({ store });
    const callee = port.calleeGraph();
    expect(callee.ok).toBe(true);
    if (callee.ok) {
      const snap = callee.value.data;
      expect(snap.edges.get('h-caller')).toContain('h-target');
      expect(snap.resolve('h-target')?.qualifiedName).toBe('target');
    }
    const caller = port.callerGraph();
    expect(caller.ok && caller.value.data.edges.get('h-target')).toContain('h-caller');
  });

  it('computes blast via graph’s canonical scoring (target has one direct caller)', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.blast('src/target.ts:1:0');
    expect(out.ok).toBe(true);
    const dto = out.ok ? out.value.data : undefined;
    expect(dto?.direct).toBe(1);
    expect(dto?.symbol.qualifiedName).toBe('target');
  });

  it('blast on an unknown symbolId is ok with undefined data', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.blast('src/nope.ts:1:0');
    expect(out.ok && out.value.data).toBeUndefined();
  });

  it('reports dead code (orphans) and honors the limit with truncated', () => {
    const port = new SqliteGraphReadPort({ store });
    const all = port.deadCode();
    expect(all.ok).toBe(true);
    const total = all.ok ? all.value.data.length : 0;
    expect(total).toBeGreaterThanOrEqual(2);
    const capped = port.deadCode(1);
    expect(capped.ok && capped.value.data).toHaveLength(1);
    expect(capped.ok && capped.value.truncated).toBe(true);
  });

  it('summarizes architecture (function/edge counts, languages, hotspots)', () => {
    const port = new SqliteGraphReadPort({ store });
    const out = port.architectureSummary();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.functionCount).toBe(4);
      expect(out.value.data.languages).toEqual(['typescript']);
      expect(out.value.data.edgeCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('SqliteGraphReadPort — freshness', () => {
  it('reports fresh:true (unverified) when no freshness context is wired', () => {
    seed(seededCatalog());
    const port = new SqliteGraphReadPort({ store });
    expect(port.freshness()).toEqual({ fresh: true, builtAt: BUILT_AT });
  });

  it('a pre-fingerprint catalog still loads and classifies without throwing (forward-compat)', () => {
    const { filesFingerprint, ...withoutFp } = seededCatalog();
    void filesFingerprint;
    seed(withoutFp);
    // Freshness context provider returns undefined for a catalog with no fingerprint.
    const port = new SqliteGraphReadPort({
      store,
      freshnessContext: workingTreeContextFromCatalog,
    });
    expect(() => port.freshness()).not.toThrow();
    expect(port.freshness().fresh).toBe(true);
    // Reads still work over the older-shaped occurrences.
    expect(port.searchSymbols('caller').ok).toBe(true);
  });
});

describe('SqliteGraphReadPort — generation snapshotting (TOCTOU-safe refresh)', () => {
  it('an interleaved read sees the stable OLD generation until a slow refresh swaps', async () => {
    seed(seededCatalog(BUILT_AT));
    const NEW_BUILT_AT = '2026-06-01T00:00:00.000Z';
    let releaseRebuild!: (catalog: Catalog) => void;
    const rebuildGate = new Promise<Catalog>((resolve) => {
      releaseRebuild = resolve;
    });
    const port = new SqliteGraphReadPort({ store, rebuild: () => rebuildGate });

    const builtAt = (): string | undefined => {
      const out = port.getGeneration();
      return out.ok ? out.value.data?.builtAt : undefined;
    };

    // Pin the current generation.
    expect(builtAt()).toBe(BUILT_AT);

    // Start a refresh but do not let the rebuild resolve yet.
    const refreshing = port.refresh();
    // Mid-rebuild, reads still see the OLD generation.
    expect(builtAt()).toBe(BUILT_AT);

    // Let the rebuild complete; the generation swaps atomically on resolve.
    releaseRebuild(seededCatalog(NEW_BUILT_AT));
    const result = await refreshing;
    expect(result.ok).toBe(true);
    expect(builtAt()).toBe(NEW_BUILT_AT);
  });
});

describe('SqliteGraphReadPort — every read degrades gracefully on a missing catalog', () => {
  it('returns empty/undefined ok results (never throws, never auto-builds)', () => {
    const port = new SqliteGraphReadPort({ store });
    const search = port.searchSymbols('x');
    expect(search.ok && search.value.data).toEqual([]);
    const span = port.findBySpan('a.ts', 1);
    expect(span.ok && span.value.data).toEqual([]);
    const blast = port.blast('a.ts:1:0');
    expect(blast.ok && blast.value.data).toBeUndefined();
    const dead = port.deadCode();
    expect(dead.ok && dead.value.data).toEqual([]);
    const caller = port.callerGraph();
    if (caller.ok) {
      expect(caller.value.data.edges.size).toBe(0);
      expect(caller.value.data.resolve('h')).toBeUndefined();
    }
    const callee = port.calleeGraph();
    if (callee.ok) expect(callee.value.data.edges.size).toBe(0);
    const arch = port.architectureSummary();
    expect(arch.ok && arch.value.data.functionCount).toBe(0);
    expect(arch.ok && arch.value.freshness).toEqual({ fresh: false, reason: 'missing' });
  });
});

describe('SqliteGraphReadPort — search excludes module-init occurrences', () => {
  it('a <module-init> occurrence whose name matches the query is not returned', () => {
    seed(
      makeCatalog({
        functions: {
          '<module-init:mod.ts>': [
            fnOcc({
              bodyHash: 'h-mod',
              simpleName: 'modinit-target',
              filePath: 'mod.ts',
              kind: 'module-init',
            }),
          ],
          real: [fnOcc({ bodyHash: 'h-real', simpleName: 'modinit-real', filePath: 'real.ts' })],
        },
      }),
    );
    const port = new SqliteGraphReadPort({ store });
    const out = port.searchSymbols('modinit');
    expect(out.ok && out.value.data.map((r) => r.qualifiedName)).toEqual(['modinit-real']);
  });
});

describe('SqliteGraphReadPort — concurrent refresh serializes to one rebuild', () => {
  it('two overlapping refresh() calls share a single in-flight build', async () => {
    seed(seededCatalog());
    let rebuilds = 0;
    const port = new SqliteGraphReadPort({
      store,
      rebuild: async () => {
        rebuilds += 1;
        await Promise.resolve();
        return seededCatalog('2026-07-01T00:00:00.000Z');
      },
    });
    const [a, b] = await Promise.all([port.refresh(), port.refresh()]);
    expect(a.ok && b.ok).toBe(true);
    expect(rebuilds).toBe(1);
  });
});

describe('persistence invariant — MCP adds no migration', () => {
  it('no datastore migration references "mcp" (read-only server owns no schema)', () => {
    const migrationsDir = fileURLToPath(new URL('../../../datastore/migrations', import.meta.url));
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const file of sqlFiles) {
      const contents = readFileSync(join(migrationsDir, file), 'utf8').toLowerCase();
      expect(contents, `${file} must not introduce an mcp-owned table`).not.toContain('mcp');
    }
  });
});
