/**
 * Seeded flat-large fixture generator (ADR-0045 B1 measurement plane).
 *
 * Materializes a deterministic ~3,000-file TypeScript corpus whose import
 * structure is CLUSTERED but whose directory layout is deliberately
 * MISALIGNED with the clusters: file `i` belongs to cluster
 * `i % clusterCount` but lives in directory
 * `src/d{floor(i / ceil(fileCount / dirCount))}` — sequential directory
 * blocks each contain files of ALL clusters, so no directory prefix aligns
 * with any cluster. (If they aligned, `hybrid` would trivially win and the
 * partition experiment would measure nothing.)
 *
 * Properties the measurement protocol depends on:
 *
 *   - **Deterministic.** All content derives from a seeded mulberry32 rng —
 *     NO `Date.now`, NO `Math.random`. Two generations with the same spec
 *     are byte-identical file-by-file.
 *   - **Warm-safe.** If `targetDir` already exists the generator returns
 *     `{ skipped: true }` and touches NOTHING — the fragment cache's
 *     files-fingerprint is mtime+size, so a rewrite would silently destroy
 *     every warm measurement. Callers wanting a fresh fixture remove the
 *     directory first.
 *   - **Acyclic by construction.** Every import targets a LOWER-indexed
 *     file, keeping `graph:cycle` signals out of the measurement noise so
 *     cold wall-times compare clean rule work across strategies.
 *   - **flat-large by construction.** One root `tsconfig.json` + a minimal
 *     root `package.json` with no `workspaces` and no nested package.json,
 *     so `detectMonorepoLayout` classifies the corpus `flat-large` once the
 *     file count crosses the 2500 threshold.
 *
 * The generator does NOT write `opensip-tools.config.yml` — the bench
 * script (`scripts/bench-partition-strategies.mjs`) owns strategy toggling.
 * It lives under `__tests__/` with the `_`-prefix non-test convention
 * (precedent: `_equivalence-harness.ts`); the engine tsconfig compiles it
 * into `dist/`, which is how the bench script (a plain Node program that
 * may not import `@opensip-tools/test-support`, ADR-0040) consumes it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Tunables for {@link generateFlatLargeFixture}. All optional. */
export interface FlatLargeFixtureSpec {
  /** Total generated `.ts` files. Default 3000 (just past the 2500 flat-large threshold). */
  readonly fileCount?: number;
  /** Import-cluster count (file `i` ∈ cluster `i % clusterCount`). Default 30. */
  readonly clusterCount?: number;
  /** Directory count under `src/` (sequential index blocks). Default 12. */
  readonly dirCount?: number;
  /** mulberry32 seed for all rng-driven choices. Default 0xf1a7. */
  readonly seed?: number;
}

/** What {@link generateFlatLargeFixture} produced (or skipped). */
export interface FlatLargeFixtureResult {
  readonly fileCount: number;
  readonly clusterCount: number;
  /** True when `targetDir` already existed — NOTHING was touched (warm-safe). */
  readonly skipped: boolean;
}

const DEFAULT_FILE_COUNT = 3000;
const DEFAULT_CLUSTER_COUNT = 30;
const DEFAULT_DIR_COUNT = 12;
const DEFAULT_SEED = 0xf1_a7;

/** Same-cluster import fan-in bounds: each file calls 3–5 lower-indexed members. */
const MIN_SAME_CLUSTER_IMPORTS = 3;
const MAX_SAME_CLUSTER_IMPORTS = 5;
/** Every Nth file adds ONE cross-cluster import+call (sparse inter-cluster edges). */
const CROSS_CLUSTER_EVERY = 10;

/**
 * Generate the fixture into `targetDir` (created; must not exist for a
 * fresh generation). Returns `{ skipped: true }` without touching anything
 * when `targetDir` already exists — see the module docstring's warm-safety
 * contract.
 */
export function generateFlatLargeFixture(
  targetDir: string,
  spec?: FlatLargeFixtureSpec,
): FlatLargeFixtureResult {
  const fileCount = spec?.fileCount ?? DEFAULT_FILE_COUNT;
  const clusterCount = spec?.clusterCount ?? DEFAULT_CLUSTER_COUNT;
  const dirCount = spec?.dirCount ?? DEFAULT_DIR_COUNT;
  const seed = spec?.seed ?? DEFAULT_SEED;
  if (existsSync(targetDir)) {
    return { fileCount, clusterCount, skipped: true };
  }

  const rng = mulberry32(seed);
  const blockSize = Math.ceil(fileCount / dirCount);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'package.json'), `${fixturePackageJson()}\n`, 'utf8');
  writeFileSync(join(targetDir, 'tsconfig.json'), `${fixtureTsconfig()}\n`, 'utf8');

  const madeDirs = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    const rel = fileRelPath(i, blockSize);
    const dirAbs = join(targetDir, posix.dirname(rel));
    if (!madeDirs.has(dirAbs)) {
      mkdirSync(dirAbs, { recursive: true });
      madeDirs.add(dirAbs);
    }
    const content = renderFile({ index: i, fileCount, clusterCount, blockSize, rng });
    writeFileSync(join(targetDir, rel), content, 'utf8');
  }
  return { fileCount, clusterCount, skipped: false };
}

/**
 * Repo-relative POSIX path of generated file `index` — exposed so callers
 * (the unit test, the bench script's W2 edit step) can derive a generated
 * file's location from the same layout math the generator used.
 */
export function fileRelPath(index: number, blockSize: number): string {
  return `src/d${String(Math.floor(index / blockSize))}/${fileName(index)}.ts`;
}

/**
 * Seeded deterministic PRNG (mulberry32) — 32-bit state, floats in [0,1).
 * Local ~6-line implementation; never a dependency, never Math.random.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function fileName(index: number): string {
  return `f${String(index).padStart(4, '0')}`;
}

function fixturePackageJson(): string {
  // NO `workspaces`, and the generator writes no nested package.json — so
  // `detectMonorepoLayout` classifies the corpus `flat-large` (not `workspaces`).
  return JSON.stringify({ name: 'flat-large-fixture', private: true, type: 'module' }, null, 2);
}

function fixtureTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', noEmit: true },
      include: ['src'],
    },
    null,
    2,
  );
}

interface RenderFileInput {
  readonly index: number;
  readonly fileCount: number;
  readonly clusterCount: number;
  readonly blockSize: number;
  readonly rng: () => number;
}

/**
 * Render one fixture file: import + CALL 3–5 lower-indexed same-cluster
 * functions (call edges are what becomes `CrossBoundaryCall`s when severed),
 * and — every {@link CROSS_CLUSTER_EVERY}th file — ONE lower-indexed file
 * from another cluster. Lower-index-only targets keep the corpus acyclic.
 */
function renderFile(input: RenderFileInput): string {
  const { index, clusterCount, blockSize, rng } = input;
  const targets = pickSameClusterTargets(index, clusterCount, rng);
  if (index % CROSS_CLUSTER_EVERY === 0 && index > 0) {
    targets.push(pickCrossClusterTarget(index, clusterCount, rng));
  }

  const ownRel = fileRelPath(index, blockSize);
  const lines: string[] = [];
  for (const target of targets) {
    const spec = relativeSpecifier(ownRel, fileRelPath(target, blockSize));
    lines.push(`import { ${fileName(target)} } from '${spec}';`);
  }
  if (targets.length > 0) lines.push('');
  const calls = targets.map((t) => ` + ${fileName(t)}()`).join('');
  lines.push(
    `export function ${fileName(index)}(): number {`,
    `  return ${String(index)}${calls};`,
    `}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Pick 3–5 distinct LOWER-indexed same-cluster targets (all of them when
 * fewer exist). Sampling consumes the shared rng sequentially, so the
 * choice is a pure function of (seed, index).
 */
function pickSameClusterTargets(index: number, clusterCount: number, rng: () => number): number[] {
  const candidates: number[] = [];
  for (let j = index - clusterCount; j >= 0; j -= clusterCount) {
    candidates.push(j);
  }
  const span = MAX_SAME_CLUSTER_IMPORTS - MIN_SAME_CLUSTER_IMPORTS + 1;
  const want = Math.min(candidates.length, MIN_SAME_CLUSTER_IMPORTS + Math.floor(rng() * span));
  const picked: number[] = [];
  for (let k = 0; k < want; k++) {
    const at = Math.floor(rng() * candidates.length);
    picked.push(...candidates.splice(at, 1));
  }
  picked.sort((a, b) => a - b);
  return picked;
}

/**
 * Pick ONE lower-indexed target from a DIFFERENT cluster. A bounded
 * forward probe lands on the first lower-indexed file outside the caller's
 * cluster when the initial draw collides (clusterCount ≥ 2 guarantees one
 * exists for index ≥ 1 except when every lower index shares the cluster,
 * which only happens for index < 2 — callers gate on index > 0 and
 * `index % CROSS_CLUSTER_EVERY === 0`, so index ≥ 10).
 */
function pickCrossClusterTarget(index: number, clusterCount: number, rng: () => number): number {
  let j = Math.floor(rng() * index);
  for (let probe = 0; probe < index && j % clusterCount === index % clusterCount; probe++) {
    j = (j + 1) % index;
  }
  return j;
}

/** Relative import specifier (with `.js` extension) from one generated file to another. */
function relativeSpecifier(fromRel: string, toRel: string): string {
  const spec = posix.relative(posix.dirname(fromRel), toRel).replace(/\.ts$/, '.js');
  return spec.startsWith('.') ? spec : `./${spec}`;
}
