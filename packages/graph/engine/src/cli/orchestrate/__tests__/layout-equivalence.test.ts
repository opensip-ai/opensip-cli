/**
 * LAYOUT-EQUIVALENCE oracle (H2/H3) — the proof that cross-package resolution +
 * package attribution are layout-AGNOSTIC.
 *
 * Four fixture repos (`../__fixtures__/layout-equivalence/{flat,nested,mixed,
 * single}`) encode the SAME logical cross-package graph in structurally DIFFERENT
 * layouts:
 *   - flat   — `packages/<name>/`                       (the canonical monorepo)
 *   - nested — `packages/<group>/<name>/`               (a grouped monorepo)
 *   - mixed  — `libs/<name>/` + `apps/<name>/`          (a NON-`packages/` repo)
 *   - single — ONE package at the repo root             (no nesting)
 *
 * The logical graph (see the fixtures' README):
 *   app.appRun  -> util.helpFmt      (cross-package)
 *   util.helpFmt -> core.baseValue   (cross-package; NOT app's same-named decoy)
 *   util.helpFmt -> util.localPad    (intra-package, relative)
 *   core.baseValue -> core.baseValue (self-recursive leaf)
 *
 * Each fixture is built through the REAL engine pipeline (`createEquivalenceHarness`
 * → `buildSharded`/`buildSingleProgram`), then stamped with `assignPackages` (the
 * nearest-`package.json` package attribution H2 made the single source of truth).
 *
 * What the oracle asserts:
 *   1. DETERMINISM — building a fixture twice yields a byte-identical catalog
 *      (modulo the wall-clock `builtAt`), per fixture.
 *   2. FUNCTION-GRAPH EQUIVALENCE — the resolved call graph keyed by
 *      (file-stem, fn-name) is IDENTICAL across ALL FOUR layouts. Layout does
 *      not change which function resolves to which. This is the core proof.
 *   3. ATTRIBUTION/COUPLING EQUIVALENCE — the package→package coupling edges
 *      (keyed by the stamped `occurrence.package`) are IDENTICAL across the three
 *      MULTI-package layouts (flat ≡ nested ≡ mixed). The `single` layout is the
 *      documented special case: every function is one package, so the coupling
 *      collapses to a single self-bucket.
 *   4. PHANTOM-TRAP — util.helpFmt resolves to CORE's baseValue, never the app
 *      decoy, in every layout (the name-collision is never mis-linked).
 *
 * Engine-layer and language-agnostic: the harness reads the committed `.ts`
 * fixtures as TEXT (no real TypeScript adapter), reusing the production
 * cross-package helpers — so this oracle exercises the SAME layout-agnostic
 * package-grouping (`packageGroupOf`) the shipping linker uses.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assignPackages } from '../../../pipeline/assign-packages.js';
import { pkgOf } from '../../../resolve-callee.js';

import { createEquivalenceHarness } from './_equivalence-harness.js';

import type { Catalog, FunctionOccurrence } from '../../../types.js';
import type { Shard } from '../shard-model.js';

// ── fixture geography ─────────────────────────────────────────────

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'layout-equivalence',
);

/** A built fixture: its root + the shard partition + the flat file set. */
interface LayoutFixture {
  readonly name: string;
  readonly fixtureRoot: string;
  readonly shards: readonly Shard[];
  readonly allFiles: readonly string[];
  /** True for the multi-package layouts (flat/nested/mixed); false for single. */
  readonly multiPackage: boolean;
}

/** Build a shard spec for one package root with the given relative source files. */
function pkgShard(
  fixtureRoot: string,
  id: string,
  relRoot: string,
  relFiles: readonly string[],
): Shard {
  const rootDir = join(fixtureRoot, relRoot);
  return { id, rootDir, files: relFiles.map((f) => join(fixtureRoot, relRoot, f)) };
}

/** flat — `packages/<name>/`. */
function flatFixture(): LayoutFixture {
  const fixtureRoot = join(ROOT, 'flat');
  const shards = [
    pkgShard(fixtureRoot, 'pkg:core', 'packages/core', ['src/base.ts']),
    pkgShard(fixtureRoot, 'pkg:util', 'packages/util', ['src/helper.ts', 'src/local.ts']),
    pkgShard(fixtureRoot, 'pkg:app', 'packages/app', ['src/run.ts']),
  ];
  return {
    name: 'flat',
    fixtureRoot,
    shards,
    allFiles: shards.flatMap((s) => s.files),
    multiPackage: true,
  };
}

/** nested — `packages/<group>/<name>/`. */
function nestedFixture(): LayoutFixture {
  const fixtureRoot = join(ROOT, 'nested');
  const shards = [
    pkgShard(fixtureRoot, 'pkg:core', 'packages/group/core', ['src/base.ts']),
    pkgShard(fixtureRoot, 'pkg:util', 'packages/group/util', ['src/helper.ts', 'src/local.ts']),
    pkgShard(fixtureRoot, 'pkg:app', 'packages/group/app', ['src/run.ts']),
  ];
  return {
    name: 'nested',
    fixtureRoot,
    shards,
    allFiles: shards.flatMap((s) => s.files),
    multiPackage: true,
  };
}

/** mixed — a NON-`packages/` monorepo: `libs/` + `apps/`. */
function mixedFixture(): LayoutFixture {
  const fixtureRoot = join(ROOT, 'mixed');
  const shards = [
    pkgShard(fixtureRoot, 'pkg:core', 'libs/core', ['src/base.ts']),
    pkgShard(fixtureRoot, 'pkg:util', 'libs/util', ['src/helper.ts', 'src/local.ts']),
    pkgShard(fixtureRoot, 'pkg:app', 'apps/app', ['src/run.ts']),
  ];
  return {
    name: 'mixed',
    fixtureRoot,
    shards,
    allFiles: shards.flatMap((s) => s.files),
    multiPackage: true,
  };
}

/** single — ONE package at the repo root (rootDir = the fixture root, dir ''). */
function singleFixture(): LayoutFixture {
  const fixtureRoot = join(ROOT, 'single');
  const shard = pkgShard(fixtureRoot, 'pkg:single', '.', [
    'src/base.ts',
    'src/local.ts',
    'src/helper.ts',
    'src/run.ts',
  ]);
  return {
    name: 'single',
    fixtureRoot,
    shards: [shard],
    allFiles: shard.files,
    multiPackage: false,
  };
}

const FIXTURES: readonly LayoutFixture[] = [
  flatFixture(),
  nestedFixture(),
  mixedFixture(),
  singleFixture(),
];
const MULTI = FIXTURES.filter((f) => f.multiPackage);

// ── build helpers ─────────────────────────────────────────────────

/** Build the SHARDED catalog for a fixture and stamp packages (the H2 attribution). */
async function buildStampedSharded(fx: LayoutFixture): Promise<Catalog> {
  const h = createEquivalenceHarness({
    fixtureRoot: fx.fixtureRoot,
    shards: fx.shards,
    allFiles: fx.allFiles,
  });
  return assignPackages(await h.buildSharded(), fx.fixtureRoot);
}

/** Build the SINGLE-PROGRAM catalog for a fixture and stamp packages. */
async function buildStampedExact(fx: LayoutFixture): Promise<Catalog> {
  const h = createEquivalenceHarness({
    fixtureRoot: fx.fixtureRoot,
    shards: fx.shards,
    allFiles: fx.allFiles,
  });
  return assignPackages(await h.buildSingleProgram(), fx.fixtureRoot);
}

// ── layout-independent projections ────────────────────────────────

/** The basename stem of a file path (`packages/util/src/local.ts` → `local`). */
function stemOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return base.replace(/\.[A-Za-z0-9]+$/, '');
}

/** bodyHash → its occurrence's layout-INDEPENDENT logical id `stem#name`. */
function logicalIdByHash(catalog: Catalog): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const [name, occs] of Object.entries(catalog.functions)) {
    for (const o of occs ?? []) byHash.set(o.bodyHash, `${stemOf(o.filePath)}#${name}`);
  }
  return byHash;
}

/**
 * The RESOLVED function call graph, keyed by layout-independent logical id:
 * `stem#name` → sorted unique set of callee `stem#name`s. Only in-project
 * resolved targets are kept (unresolved `to:[]` and external targets drop out),
 * so the projection is the actual recovered call graph — identical across any
 * layout that resolves the same edges.
 */
function functionGraph(catalog: Catalog): Record<string, string[]> {
  const idByHash = logicalIdByHash(catalog);
  const graph: Record<string, Set<string>> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    for (const o of occs ?? []) {
      const caller = `${stemOf(o.filePath)}#${name}`;
      const callees = (graph[caller] ??= new Set<string>());
      for (const e of o.calls) {
        for (const t of e.to) {
          const id = idByHash.get(t);
          if (id !== undefined) callees.add(id);
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(graph)
      .map(([k, v]) => [k, [...v].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The package→package COUPLING edges, keyed by the STAMPED `occurrence.package`
 * (scope-stripped via `pkgOf`, exactly what the coupling grid groups by). Each
 * resolved in-project edge contributes a `caller-pkg -> callee-pkg` pair
 * (self-edges kept — they are the coupling diagonal). The sorted set of these
 * pairs is the layout-independent coupling fingerprint.
 */
function couplingEdges(catalog: Catalog): string[] {
  const pkgByHash = new Map<string, string>();
  const all: FunctionOccurrence[] = [];
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs ?? []) {
      pkgByHash.set(o.bodyHash, pkgOf(o));
      all.push(o);
    }
  }
  const edges = new Set<string>();
  for (const o of all) {
    const from = pkgOf(o);
    for (const e of o.calls) {
      for (const t of e.to) {
        const to = pkgByHash.get(t);
        if (to !== undefined) edges.add(`${from} -> ${to}`);
      }
    }
  }
  return [...edges].sort();
}

/** Serialize a catalog to a byte-comparable string EXCLUDING `builtAt`. */
function canonicalBytes(catalog: Catalog): string {
  return JSON.stringify({ ...catalog, builtAt: 'EXCLUDED' });
}

// ── the oracle ────────────────────────────────────────────────────

describe('layout-equivalence: cross-package resolution is layout-agnostic', () => {
  it.each(FIXTURES.map((f) => f.name))(
    'stamps the real package.json name (not a packages/ segment) in the %s layout',
    async (fxName) => {
      const fx = FIXTURES.find((f) => f.name === fxName);
      expect(fx).toBeDefined();
      if (fx === undefined) return;
      const catalog = await buildStampedSharded(fx);
      const packages = new Set<string>();
      for (const occs of Object.values(catalog.functions)) {
        for (const o of occs ?? []) packages.add(String(o.package));
      }
      const expected = fx.multiPackage
        ? new Set(['@eq/core', '@eq/util', '@eq/app'])
        : new Set(['@eq/single']);
      expect([...packages].sort()).toEqual([...expected].sort());
    },
  );

  it.each(FIXTURES.map((f) => f.name))(
    'is DETERMINISTIC: two builds of the %s layout are byte-identical (modulo builtAt)',
    async (fxName) => {
      const fx = FIXTURES.find((f) => f.name === fxName);
      expect(fx).toBeDefined();
      if (fx === undefined) return;
      const a = await buildStampedSharded(fx);
      const b = await buildStampedSharded(fx);
      expect(canonicalBytes(a)).toBe(canonicalBytes(b));
    },
  );

  it.each(MULTI.map((f) => f.name))(
    'resolves util.helpFmt -> CORE.baseValue, never the app decoy (phantom trap) in the %s layout',
    async (fxName) => {
      const fx = MULTI.find((f) => f.name === fxName);
      expect(fx).toBeDefined();
      if (fx === undefined) return;
      const catalog = await buildStampedSharded(fx);
      // The helpFmt occurrence (in util) must have a cross-package edge to a
      // baseValue whose owning package is @eq/core — NOT @eq/app.
      const helpFmt = catalog.functions.helpFmt?.[0];
      expect(helpFmt).toBeDefined();
      const targets = (helpFmt?.calls ?? []).flatMap((e) => [...e.to]);
      const pkgByHash = new Map<string, string>();
      for (const occs of Object.values(catalog.functions)) {
        for (const o of occs ?? []) pkgByHash.set(o.bodyHash, String(o.package));
      }
      const baseTargets = targets
        .map((t) => ({ hash: t, pkg: pkgByHash.get(t) }))
        .filter((x) => x.pkg !== undefined);
      // helpFmt reaches a baseValue, and every baseValue it reaches is in core.
      const reachedBase = baseTargets.filter((x) => {
        const occ = catalog.functions.baseValue?.find((o) => o.bodyHash === x.hash);
        return occ !== undefined;
      });
      expect(reachedBase.length).toBeGreaterThan(0);
      for (const x of reachedBase) expect(x.pkg).toBe('@eq/core');
    },
  );

  it('FUNCTION graph is IDENTICAL across ALL FOUR layouts (sharded)', async () => {
    const graphs = await Promise.all(
      FIXTURES.map(async (fx) => ({
        name: fx.name,
        graph: functionGraph(await buildStampedSharded(fx)),
      })),
    );
    const ref = graphs[0];
    expect(ref).toBeDefined();
    for (const g of graphs.slice(1)) {
      // The decoy `run#baseValue` (an app-only, callerless, calleeless node)
      // exists in the multi-package layouts but not in single; the resolved
      // call graph (callers WITH callees + every reachable node) is otherwise
      // identical. Compare the EDGE-bearing subgraph, which is layout-invariant.
      expect(edgeBearing(g.graph), `${g.name} vs ${ref?.name}`).toEqual(
        edgeBearing(ref?.graph ?? {}),
      );
    }
  });

  it('FUNCTION graph matches between sharded and single-program per layout', async () => {
    for (const fx of FIXTURES) {
      const sharded = functionGraph(await buildStampedSharded(fx));
      const exact = functionGraph(await buildStampedExact(fx));
      expect(edgeBearing(sharded), fx.name).toEqual(edgeBearing(exact));
    }
  });

  it('COUPLING edges are IDENTICAL across the three MULTI-package layouts', async () => {
    const couplings = await Promise.all(
      MULTI.map(async (fx) => ({
        name: fx.name,
        edges: couplingEdges(await buildStampedSharded(fx)),
      })),
    );
    const ref = couplings[0];
    expect(ref).toBeDefined();
    // The canonical coupling: app->util, util->core, util->util, core->core.
    expect(ref?.edges).toEqual([
      '@eq/app -> @eq/util',
      '@eq/core -> @eq/core',
      '@eq/util -> @eq/core',
      '@eq/util -> @eq/util',
    ]);
    for (const c of couplings.slice(1)) {
      expect(c.edges, `${c.name} vs ${ref?.name}`).toEqual(ref?.edges);
    }
  });

  it('COUPLING in the single-package layout collapses to one self-bucket', async () => {
    const fx = singleFixture();
    const edges = couplingEdges(await buildStampedSharded(fx));
    // Every function is in @eq/single, so all coupling is the self-edge.
    expect(edges).toEqual(['@eq/single -> @eq/single']);
  });
});

/** Keep only callers that have at least one resolved callee (drop isolated nodes
 *  like the app-only decoy and leaf-only sinks), so the comparison is over the
 *  layout-invariant edge-bearing subgraph. */
function edgeBearing(graph: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(graph).filter(([, callees]) => callees.length > 0));
}
