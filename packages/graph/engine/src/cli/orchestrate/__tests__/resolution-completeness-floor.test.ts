/**
 * Resolution-COMPLETENESS floor (ADR-0033) — the guard the differential
 * equivalence gate structurally cannot provide.
 *
 * `graph-equivalence-check` compares exact vs sharded: it catches an edge that
 * one engine resolves and the other doesn't. It is BLIND to a regression that
 * drops a cross-package edge in BOTH engines at once (they still agree → zero
 * divergence). This test closes that blind spot by asserting a NON-DECREASING
 * count of resolved cross-package edges on a PINNED corpus (the committed
 * `medium-pkg` fixture — fixed call-site denominator, so a count floor IS a
 * resolution-rate floor). Built through the SAME engine pipeline the production
 * sharded build uses (`buildAndResolveCatalog` → `mergeAndResolveShards`), so a
 * regression in the shared cross-package hop (export-index / resolveCrossPackageCall
 * / resolveOne) trips it.
 *
 * Ratchet: if you legitimately ADD resolved edges to the fixture, RAISE the
 * floor. A DROP below the floor is a completeness regression — investigate
 * before lowering.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { countResolvedCrossPackageEdges } from '../equivalence-check.js';

import { createEquivalenceHarness } from './_equivalence-harness.js';

import type { Shard } from '../shard-model.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'medium-pkg');
const PKG = (name: string): string => join(FIXTURE_ROOT, 'packages', name);

const PKG_FILES: Record<string, readonly string[]> = {
  core: [join(PKG('core'), 'src', 'index.ts')],
  util: [join(PKG('util'), 'src', 'index.ts'), join(PKG('util'), 'src', 'helpers.ts')],
  'svc-a': [join(PKG('svc-a'), 'src', 'index.ts')],
  'svc-b': [join(PKG('svc-b'), 'src', 'index.ts')],
  app: [join(PKG('app'), 'src', 'index.ts'), join(PKG('app'), '__tests__', 'index.ts')],
};
const ROOT_FILES: readonly string[] = [join(FIXTURE_ROOT, 'root-script.ts')];
const ALL_FILES: readonly string[] = [...Object.values(PKG_FILES).flat(), ...ROOT_FILES];
const SHARDS: readonly Shard[] = [
  ...Object.entries(PKG_FILES).map(
    ([name, files]): Shard => ({ id: `pkg:${name}`, rootDir: PKG(name), files: [...files] }),
  ),
  { id: ':root', rootDir: FIXTURE_ROOT, files: [...ROOT_FILES] },
];

/**
 * The post-Phase-3 achieved high-water mark of resolved cross-package edges on
 * the pinned `medium-pkg` corpus. RAISE this when you intentionally add resolved
 * cross-package edges to the fixture; a value BELOW it is a completeness
 * regression in the shared hop.
 */
const RESOLUTION_FLOOR = 7;

describe('resolution completeness floor (pinned medium-pkg corpus)', () => {
  const harness = createEquivalenceHarness({
    fixtureRoot: FIXTURE_ROOT,
    shards: SHARDS,
    allFiles: ALL_FILES,
  });

  it('resolves at least the floor of cross-package edges (catches a both-engine drop)', async () => {
    const sharded = await harness.buildSharded();
    const resolved = countResolvedCrossPackageEdges(sharded);
    expect(resolved).toBeGreaterThanOrEqual(RESOLUTION_FLOOR);
  });
});
