/**
 * repo-scale sharded ≡ exact equivalence oracle (FAST PR-gate SANITY check).
 *
 * The SHARDED build must be byte-equivalent to the SINGLE-PROGRAM (exact) build
 * on the FULL `CatalogEquivalence` — function set + intra/cross edges + SCCs —
 * over a medium multi-package fixture big enough to exercise the real divergence
 * classes, yet small enough that the EXACT engine (the oracle) completes in
 * single-digit milliseconds. It runs under `pnpm test` (Vitest), so it is in the
 * PR gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT THE AUTHORITATIVE GATE — it does NOT exercise real dist/*.d.ts
 * resolution. Both engines build through the SYNTHETIC `createEquivalenceHarness`
 * adapter that reuses the production cross-package helpers
 * (`resolveSpecifierToPackage` + `buildExportIndex`), so they AGREE BY
 * CONSTRUCTION. A real `@scope/pkg` import that Node16 resolves to a BUILT,
 * BODILESS `dist/*.d.ts` — the divergence class the exact-engine-under-resolution
 * bug lived in — is structurally unrepresentable here, so this fixture-driven
 * test could never have caught it (false confidence).
 *
 * The REAL guardrail is the dogfood CI step `graph-equivalence-check` (npm
 * `graph:equivalence:ci`): it builds BOTH catalogs on this real monorepo with the
 * real adapter (real dist/*.d.ts resolution) and ratchets the production
 * divergence against `.config/graph-equivalence-budget.json`. Keep this fast test
 * as a sanity check, but the dogfood step is what protects against an
 * edge-resolution regression on real code.
 *
 * ── DIVERGENCE CLASSES the medium fixture (`__fixtures__/medium-pkg`) covers ──
 *   - DEEP cross-package chain      : app -> svc-b -> svc-a -> {core, util}.
 *   - CROSS-PACKAGE CYCLE           : core.coreCycle <-> util.utilCycle (a
 *                                     2-member SCC that drives `cycle` findings;
 *                                     the `sccDifferences` partition guards it).
 *   - RELATIVE intra-package edge   : util.utilFormat -> ./helpers.utilHelper.
 *   - INTRA-FILE same-package edge  : core.coreInit -> core.coreHelper.
 *   - ROOT-level file               : root-script.ts (the synthetic `:root`
 *                                     shard) -> @medium/app.appMain.
 *   - TEST-tree file                : app/__tests__/app.test.ts -> app.appMain
 *                                     (kept in the canonical set; a test->prod
 *                                     cross-reference inside the package shard).
 *
 * Both engines build through the shared `createEquivalenceHarness` — the SAME
 * fixture-resolution model the small gate (`equivalence.test.ts`) uses — so
 * there is exactly one resolver, never two drifting copies.
 *
 * COLD vs WARM (determinism leg): the harness builds in-memory with no cache, so
 * "warm" is modeled as a SECOND independent build. The merged catalog is a pure
 * function of the fragment SET (shard completion order is canonicalized away), so
 * two builds must be byte-identical — and BOTH must be fully equivalent to exact.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { computeSccs } from '../../../pipeline/features.js';
import { buildIndexes } from '../../../pipeline/indexes.js';
import { diffCatalogs, isEquivalent } from '../cross-shard-resolve.js';

import { createEquivalenceHarness } from './equivalence-harness.js';

import type { Catalog } from '../../../types.js';
import type { Shard } from '../shard-model.js';

// ── medium fixture geography ──────────────────────────────────────

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'medium-pkg',
);

const PKG = (name: string): string => join(FIXTURE_ROOT, 'packages', name);

/** Every package's source files, grouped by package (the shard file lists). */
const PKG_FILES: Record<string, readonly string[]> = {
  core: [join(PKG('core'), 'src', 'index.ts')],
  util: [join(PKG('util'), 'src', 'index.ts'), join(PKG('util'), 'src', 'helpers.ts')],
  'svc-a': [join(PKG('svc-a'), 'src', 'index.ts')],
  'svc-b': [join(PKG('svc-b'), 'src', 'index.ts')],
  // pkg-app owns BOTH its src/ and its real __tests__/ tree (kept canonically).
  // The test-tree file is named `index.ts` (NOT `*.test.ts`) so Vitest's own
  // test glob never collects this FIXTURE as a runnable test — the convention
  // the function-set-gap fixture established.
  app: [join(PKG('app'), 'src', 'index.ts'), join(PKG('app'), '__tests__', 'index.ts')],
};

/** Root-level files under no packages/* unit → the synthetic `:root` shard. */
const ROOT_FILES: readonly string[] = [join(FIXTURE_ROOT, 'root-script.ts')];

const ALL_FILES: readonly string[] = [...Object.values(PKG_FILES).flat(), ...ROOT_FILES];

/** Five package shards + the synthetic `:root` shard (root shard last). */
const SHARDS: readonly Shard[] = [
  ...Object.entries(PKG_FILES).map(
    ([name, files]): Shard => ({ id: `pkg:${name}`, rootDir: PKG(name), files: [...files] }),
  ),
  { id: ':root', rootDir: FIXTURE_ROOT, files: [...ROOT_FILES] },
];

const harness = createEquivalenceHarness({
  fixtureRoot: FIXTURE_ROOT,
  shards: SHARDS,
  allFiles: ALL_FILES,
});
const { buildSingleProgram, buildSharded, bodyHashFor } = harness;

// ── SCC + serialization helpers ───────────────────────────────────

/** Sorted-member SCC signatures (the engine's own occId-keyed Tarjan). */
function sccSignatures(catalog: Catalog): string[] {
  const indexes = buildIndexes(catalog);
  return computeSccs(indexes)
    .map((scc) => [...scc.members].sort().join('|'))
    .sort();
}

/** A catalog serialized for byte-equality, EXCLUDING the wall-clock `builtAt`. */
function structural(catalog: Catalog): string {
  // `builtAt` is the sole intentionally-nondeterministic field; drop it from the
  // structural comparison via a JSON replacer rather than an unused destructure.
  return JSON.stringify(catalog, (key, value) => (key === 'builtAt' ? undefined : value));
}

/** Every call-edge target of the first occurrence of `name` in `catalog`. */
function targetsOf(catalog: Catalog, name: string): readonly string[] {
  return (catalog.functions[name]?.[0]?.calls ?? []).flatMap((e) => [...e.to]);
}

const CORE_CYCLE = bodyHashFor('packages/core/src/index.ts', 'coreCycle');
const UTIL_CYCLE = bodyHashFor('packages/util/src/index.ts', 'utilCycle');

/**
 * The expected 2-member cross-package cycle's SCC signature, derived from the
 * catalog's own occurrences (occId = `filePath:line:column`) so it tracks the
 * harness's column model rather than a hardcoded guess.
 */
function cycleSignature(catalog: Catalog): string {
  const occId = (simpleName: string, filePath: string): string => {
    const occ = (catalog.functions[simpleName] ?? []).find((o) => o.filePath === filePath);
    if (occ === undefined) throw new Error(`missing occurrence ${simpleName} in ${filePath}`);
    return `${occ.filePath}:${String(occ.line)}:${String(occ.column)}`;
  };
  return [
    occId('coreCycle', 'packages/core/src/index.ts'),
    occId('utilCycle', 'packages/util/src/index.ts'),
  ]
    .sort()
    .join('|');
}

// ── the gate ──────────────────────────────────────────────────────

describe('repo-scale equivalence guardrail (Phase 4 gate)', () => {
  it('sharded is FULLY equivalent to exact — function set + edges + SCCs (COLD)', async () => {
    const exact = await buildSingleProgram();
    const sharded = await buildSharded();

    const eq = diffCatalogs(sharded, exact);
    expect(eq.functionsOnlyInA).toEqual([]);
    expect(eq.functionsOnlyInB).toEqual([]);
    expect(eq.intraMismatches).toEqual([]);
    expect(eq.crossDifferences).toEqual([]);
    expect(eq.sccDifferences).toEqual([]);
    expect(isEquivalent(eq)).toBe(true);
  });

  it('stays FULLY equivalent on a second (WARM) build — determinism leg', async () => {
    const exact = await buildSingleProgram();
    const shardedCold = await buildSharded();
    const shardedWarm = await buildSharded();

    // The two sharded builds are byte-identical (merge is a pure function of the
    // fragment set; completion order is canonicalized away).
    expect(structural(shardedWarm)).toEqual(structural(shardedCold));
    // …and the warm build is equally fully-equivalent to exact.
    expect(isEquivalent(diffCatalogs(shardedWarm, exact))).toBe(true);
  });

  it('recovers the deep cross-package chain (app → svc-b → svc-a → core/util)', async () => {
    const sharded = await buildSharded();
    const exact = await buildSingleProgram();

    for (const cat of [sharded, exact]) {
      expect(targetsOf(cat, 'appMain')).toContain(bodyHashFor('packages/svc-b/src/index.ts', 'svcBRun'));
      expect(targetsOf(cat, 'svcBRun')).toContain(bodyHashFor('packages/svc-a/src/index.ts', 'svcARun'));
      expect(targetsOf(cat, 'svcARun')).toContain(bodyHashFor('packages/core/src/index.ts', 'coreInit'));
      expect(targetsOf(cat, 'svcARun')).toContain(bodyHashFor('packages/util/src/index.ts', 'utilFormat'));
    }
  });

  it('forms the cross-package cycle SCC identically in both engines', async () => {
    const exact = await buildSingleProgram();
    const sharded = await buildSharded();

    const exactSccs = sccSignatures(exact);
    const shardedSccs = sccSignatures(sharded);
    expect(shardedSccs).toEqual(exactSccs);
    // The expected 2-member { coreCycle, utilCycle } component is actually present
    // (not vacuously equal because neither engine found it).
    expect(shardedSccs).toContain(cycleSignature(sharded));

    // And the edges that form the cycle are recovered cross-shard in sharded.
    const coreCycleEdges = sharded.functions.coreCycle?.[0]?.calls ?? [];
    const utilCycleEdges = sharded.functions.utilCycle?.[0]?.calls ?? [];
    expect(coreCycleEdges.some((e) => e.to.includes(UTIL_CYCLE) && e.crossShard)).toBe(true);
    expect(utilCycleEdges.some((e) => e.to.includes(CORE_CYCLE) && e.crossShard)).toBe(true);
  });

  it('links the root-level and test-tree cross-package edges to app.appMain', async () => {
    const sharded = await buildSharded();
    const exact = await buildSingleProgram();
    const appMain = bodyHashFor('packages/app/src/index.ts', 'appMain');

    for (const cat of [sharded, exact]) {
      expect(targetsOf(cat, 'rootRun')).toContain(appMain); // root shard → prod
      expect(targetsOf(cat, 'testApp')).toContain(appMain); // test tree → prod
    }
  });
});
