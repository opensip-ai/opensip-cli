/**
 * Phase 4 equivalence guardrail: the SHARDED build must equal the
 * SINGLE-PROGRAM build on a committed multi-package fixture — for the FULL
 * `CatalogEquivalence` (function set + intra/cross edges + SCCs) — with the
 * `canonicalize`-style phantom as a named regression case.
 *
 * The fixture (`../__fixtures__/multi-pkg`) is three tiny workspace packages
 * plus a root-level file and an out-of-`src`-tree file:
 *   - @fixture/a       — `main` calls `@fixture/foundation.canonicalize` (bare
 *                        workspace specifier → genuine cross-package edge) and
 *                        `./local.formatLocal` (relative → intra-package edge);
 *                        `scripts/gen.ts` (OUT of src/) calls foundation too.
 *   - @fixture/foundation — `canonicalize` is self-recursive (the leaf-util case).
 *   - @fixture/b       — ALSO exports `canonicalize`, which pkg-a NEVER imports.
 *                        A name-only resolver would link pkg-a → b.canonicalize:
 *                        the phantom trap this gate catches.
 *   - root-tool.ts     — a ROOT-LEVEL file (no packages/* unit → `:root` shard)
 *                        whose bare import must link from the root shard.
 *
 * We build the SAME files two ways through the REAL engine pipeline (the shared
 * `createEquivalenceHarness`): single-program → one `buildAndResolveCatalog`
 * over ALL files; sharded → one per shard (emitting boundary calls) merged +
 * linked by `mergeAndResolveShards`. Then `diffCatalogs(sharded, singleProgram)`
 * must report EVERY partition empty. The harness's fixture-driven adapter reuses
 * the SAME engine helpers the linker uses (`resolveSpecifierToPackage` +
 * `buildExportIndex`), so the single-program oracle and the sharded linker agree
 * by construction — and both decline the phantom.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE / WHAT THIS TEST DOES *NOT* COVER — read before trusting it as the gate:
 *
 * This is a FAST PR-gate SANITY check, NOT the authoritative equivalence gate.
 * Because BOTH engines build through the SYNTHETIC text adapter that reuses the
 * production cross-package helpers, they AGREE BY CONSTRUCTION — this test
 * structurally CANNOT model the REAL TypeScript `dist/*.d.ts` resolution, where
 * a `@scope/pkg` import binds to a BUILT, BODILESS declaration file. That is the
 * exact divergence class the exact-engine-under-resolution bug lived in, and
 * this fixture-driven test could never have caught it.
 *
 * The REAL guardrail is the dogfood CI step `graph-equivalence-check` (npm
 * `graph:equivalence:ci`), which builds BOTH catalogs on this real monorepo with
 * the real adapter (real dist/*.d.ts resolution) and ratchets the production
 * divergence against `.config/graph-equivalence-budget.json`. Do NOT mistake a
 * green run here for byte-equivalence on real code.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { diffCatalogs, diffCatalogsByEdge, isEquivalent } from '../cross-shard-resolve.js';

import { createEquivalenceHarness } from './equivalence-harness.js';

import type { CallEdge, Catalog, FunctionOccurrence } from '../../../types.js';
import type { Shard } from '../shard-model.js';

// ── fixture geography ─────────────────────────────────────────────

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'multi-pkg',
);

/** The three package roots (absolute) — one shard each. */
const PKG_DIRS = {
  a: join(FIXTURE_ROOT, 'packages', 'a'),
  foundation: join(FIXTURE_ROOT, 'packages', 'foundation'),
  b: join(FIXTURE_ROOT, 'packages', 'b'),
} as const;

/**
 * Every fixture `.ts` source, absolute, grouped by package. pkg-a additionally
 * owns an OUT-OF-`src`-tree file (`scripts/gen.ts`): it lives under packages/a
 * so the partitioner assigns it to the pkg-a shard, but a `src`-only tsconfig
 * would exclude it — the canonical-file-set gap Phase 1 closed.
 */
const PKG_FILES: Record<keyof typeof PKG_DIRS, readonly string[]> = {
  a: [
    join(PKG_DIRS.a, 'src', 'main.ts'),
    join(PKG_DIRS.a, 'src', 'local.ts'),
    join(PKG_DIRS.a, 'scripts', 'gen.ts'),
  ],
  foundation: [join(PKG_DIRS.foundation, 'src', 'canonicalize.ts')],
  b: [join(PKG_DIRS.b, 'src', 'util.ts')],
};

/**
 * A ROOT-LEVEL file under NO packages/* unit → the synthetic `:root` shard. A
 * bare workspace import from a root file (whose `packageOf` is `<unknown>`) must
 * link to the imported package's unique export, and the `:root` shard's rootDir
 * (which has no package.json) must not crash the manifest index.
 */
const ROOT_FILES: readonly string[] = [join(FIXTURE_ROOT, 'root-tool.ts')];

const ALL_FILES: readonly string[] = [...Object.values(PKG_FILES).flat(), ...ROOT_FILES];

/**
 * The four shards: one per workspace package + the synthetic `:root` shard
 * (rootDir = FIXTURE_ROOT). The root shard's rootDir has NO package.json, so
 * `buildPackageManifestIndex` skips it — it stays a non-resolvable shard whose
 * files still merge and whose bare imports link against the OTHER packages'
 * manifests. Mirrors `partitionFilesIntoShards` (root shard last).
 */
const FIXTURE_SHARDS: readonly Shard[] = [
  { id: 'pkg:a', rootDir: PKG_DIRS.a, files: [...PKG_FILES.a] },
  { id: 'pkg:foundation', rootDir: PKG_DIRS.foundation, files: [...PKG_FILES.foundation] },
  { id: 'pkg:b', rootDir: PKG_DIRS.b, files: [...PKG_FILES.b] },
  { id: ':root', rootDir: FIXTURE_ROOT, files: [...ROOT_FILES] },
];

const harness = createEquivalenceHarness({
  fixtureRoot: FIXTURE_ROOT,
  shards: FIXTURE_SHARDS,
  allFiles: ALL_FILES,
});
const { buildSingleProgram, buildSharded, bodyHashFor } = harness;

// ── edge-lookup helpers for the named assertions ──────────────────

const FOUNDATION_CANON = bodyHashFor('packages/foundation/src/canonicalize.ts', 'canonicalize');
const B_CANON = bodyHashFor('packages/b/src/util.ts', 'canonicalize');
const A_LOCAL = bodyHashFor('packages/a/src/local.ts', 'formatLocal');

function mainEdges(catalog: Catalog): readonly CallEdge[] {
  return catalog.functions.main?.[0]?.calls ?? [];
}

function targetsOf(catalog: Catalog): readonly string[] {
  return mainEdges(catalog).flatMap((e) => [...e.to]);
}

/** Every call edge of a single named occurrence (first occurrence of `name`). */
function edgesOf(catalog: Catalog, name: string): readonly CallEdge[] {
  return catalog.functions[name]?.[0]?.calls ?? [];
}

/** Sorted, deduped set of project-relative file paths present in a catalog. */
function filesOf(catalog: Catalog): string[] {
  return [...new Set(Object.values(catalog.functions).flat().map((o) => o.filePath))].sort();
}

// ── the gate ──────────────────────────────────────────────────────

describe('exact-sharding equivalence guardrail', () => {
  it('sharded build equals single-program build on BOTH intra- and cross-package edges', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    const diff = diffCatalogsByEdge(sharded, singleProgram);

    // Intra-package edges must already match (Phase 0/Phase 2 invariant)…
    expect(diff.intraMismatches).toEqual([]);
    // …and with semantic linking, cross-package edges must match too: a
    // non-empty crossDifferences is a correctness regression (Phase 4).
    expect(diff.crossDifferences).toEqual([]);
  });

  it('is FULLY equivalent — function set + edges + SCCs all empty (Phase 4 gate)', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    const eq = diffCatalogs(sharded, singleProgram);
    // Function set is byte-identical (the merge-dedup column fix) …
    expect(eq.functionsOnlyInA).toEqual([]);
    expect(eq.functionsOnlyInB).toEqual([]);
    // … edges match on both partitions …
    expect(eq.intraMismatches).toEqual([]);
    expect(eq.crossDifferences).toEqual([]);
    // … and the SCC membership (cycle-finding driver) matches.
    expect(eq.sccDifferences).toEqual([]);
    expect(isEquivalent(eq)).toBe(true);
  });

  it('builds the two catalogs over the same project-relative file set', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();
    expect(filesOf(sharded)).toEqual(filesOf(singleProgram));
    // The set includes the root-level file and the out-of-src-tree file.
    expect(filesOf(sharded)).toContain('root-tool.ts');
    expect(filesOf(sharded)).toContain('packages/a/scripts/gen.ts');
  });

  it('links the ROOT-shard file cross-package edge (rootMain → foundation.canonicalize)', async () => {
    const sharded = await buildSharded();
    const singleProgram = await buildSingleProgram();
    // A root-level file (under no packages/* unit, `:root` shard) must link its
    // bare workspace import to the unique export — the `:root` shard neither
    // crashes the manifest index nor declines a genuine boundary call.
    const rootEdge = edgesOf(sharded, 'rootMain').find((e) => e.to.includes(FOUNDATION_CANON));
    expect(rootEdge?.crossShard).toBe(true);
    expect(rootEdge?.resolution).toBe('semantic');
    // And the single-program oracle resolves the SAME edge (no cross-shard flag).
    expect(edgesOf(singleProgram, 'rootMain').flatMap((e) => [...e.to])).toContain(FOUNDATION_CANON);
  });

  it('links the OUT-OF-src-tree file cross-package edge (genFixtures → foundation.canonicalize)', async () => {
    const sharded = await buildSharded();
    const singleProgram = await buildSingleProgram();
    // packages/a/scripts/gen.ts is in the pkg-a shard but outside src/ — the
    // canonical-file-set inclusion gap. Its cross-package call must link in both.
    const genEdge = edgesOf(sharded, 'genFixtures').find((e) => e.to.includes(FOUNDATION_CANON));
    expect(genEdge?.crossShard).toBe(true);
    expect(genEdge?.resolution).toBe('semantic');
    expect(edgesOf(singleProgram, 'genFixtures').flatMap((e) => [...e.to])).toContain(
      FOUNDATION_CANON,
    );
  });

  it('keeps the genuine pkg-a → foundation.canonicalize cross-package edge', async () => {
    const sharded = await buildSharded();
    expect(targetsOf(sharded)).toContain(FOUNDATION_CANON);
    // And it is recovered as a semantic cross-shard edge in the sharded build.
    const edge = mainEdges(sharded).find((e) => e.to.includes(FOUNDATION_CANON));
    expect(edge?.crossShard).toBe(true);
    expect(edge?.resolution).toBe('semantic');
  });

  it('NEVER links the phantom pkg-a → b.canonicalize (name-collision trap)', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();
    expect(targetsOf(singleProgram)).not.toContain(B_CANON);
    expect(targetsOf(sharded)).not.toContain(B_CANON);
  });

  it('keeps the relative intra-package edge pkg-a main → ./local.formatLocal', async () => {
    const sharded = await buildSharded();
    const singleProgram = await buildSingleProgram();
    expect(targetsOf(sharded)).toContain(A_LOCAL);
    expect(targetsOf(singleProgram)).toContain(A_LOCAL);
  });

  it('preserves the self-recursive foundation.canonicalize edge', async () => {
    const sharded = await buildSharded();
    const selfCalls = sharded.functions.canonicalize?.find(
      (o) => o.filePath === 'packages/foundation/src/canonicalize.ts',
    )?.calls;
    expect(selfCalls?.some((e) => e.to.includes(FOUNDATION_CANON))).toBe(true);
  });

  // ── the gate has teeth (regression-detector guard) ──────────────
  //
  // The assertions above prove the SHIPPING semantic linker agrees with the
  // single-program oracle (crossDifferences empty) and declines the phantom.
  // This pair proves the gate would actually FAIL if the linker regressed — that
  // the empty `crossDifferences` is a real signal, not a vacuous pass. We do NOT
  // revert production code (CLAUDE.md / Phase 4): instead we synthesize the two
  // canonical regressions on a COPY of the real sharded catalog and assert
  // `diffCatalogsByEdge` lands them in `crossDifferences`.

  it('FAILS the gate if the linker degrades to a name-only phantom (b.canonicalize)', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    // Sanity: the honest sharded build matches the oracle (the gate's green case).
    expect(diffCatalogsByEdge(sharded, singleProgram).crossDifferences).toEqual([]);

    // Simulate the OLD name-only fallback: at main's genuine cross-package edge,
    // swap the target from foundation.canonicalize → b.canonicalize (the phantom
    // a name-only resolver fabricates by matching the globally-unique-ish simple
    // name into a package pkg-a never imported).
    const degraded = rewriteCrossEdgeTarget(sharded, FOUNDATION_CANON, B_CANON);
    expect(targetsOf(degraded)).toContain(B_CANON); // the phantom is now present

    const diff = diffCatalogsByEdge(degraded, singleProgram);
    expect(diff.crossDifferences.length).toBeGreaterThan(0); // gate catches it
  });

  it('FAILS the gate if the linker DROPS the genuine cross-package edge', async () => {
    const singleProgram = await buildSingleProgram();
    const sharded = await buildSharded();

    // The other regression direction: the linker declines an edge the single
    // program resolves (e.g. it stopped following the bare-specifier export
    // link). Clear main's cross-package target → an empty `to` at that site.
    const dropped = rewriteCrossEdgeTarget(sharded, FOUNDATION_CANON, undefined);
    expect(targetsOf(dropped)).not.toContain(FOUNDATION_CANON);

    const diff = diffCatalogsByEdge(dropped, singleProgram);
    expect(diff.crossDifferences.length).toBeGreaterThan(0); // gate catches it
  });
});

/**
 * Return a COPY of `catalog` in which every cross-shard edge whose target set
 * contains `from` has it replaced by `to` (or removed when `to === undefined`).
 * Used ONLY by the regression-detector guards to synthesize a degraded linker
 * output without touching production resolution code.
 */
function rewriteCrossEdgeTarget(
  catalog: Catalog,
  from: string,
  to: string | undefined,
): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const [name, occs] of Object.entries(catalog.functions)) {
    if (!occs) continue;
    functions[name] = occs.map((o) => ({
      ...o,
      calls: o.calls.map((e) =>
        e.crossShard && e.to.includes(from)
          ? { ...e, to: to === undefined ? [] : e.to.map((t) => (t === from ? to : t)) }
          : e,
      ),
    }));
  }
  return { ...catalog, functions };
}
