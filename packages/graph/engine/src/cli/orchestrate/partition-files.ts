/**
 * Partition the canonical file set across shards by longest-matching root dir.
 *
 * Phase 1 of graph-sharded-exact-parity. The sharded engine used to RE-DERIVE
 * each shard's files from that package's own tsconfig — which excludes the
 * package's `__fixtures__` tree AND (for some packages) its test files — so it
 * silently dropped files the exact engine kept. The fix: enumerate the project
 * once (root discovery → {@link resolveCanonicalFileSet}), then ASSIGN each
 * canonical file to a shard here. Discovery now only supplies shard BOUNDARIES
 * (rootDir + configPath), never the file set.
 *
 * Assignment rule: each file goes to the unit whose `rootDir` is its LONGEST
 * matching path prefix (so a file under `packages/foo/src/...` lands in the
 * `foo` unit, not a shorter-prefix ancestor unit). Files under NO unit's
 * rootDir — root scripts, `.config`, files in packages without a tsconfig —
 * fall into a synthetic ROOT shard anchored at the project root + root tsconfig.
 *
 * Invariant (asserted by callers' tests): `union(shard.files) === canonicalFiles`
 * and every file lands in EXACTLY one shard — the partition is total and
 * disjoint, which is what makes the merged sharded catalog equal the exact one.
 */

import { toPosixPath } from '../../cross-package/posix-path.js';

import type { Shard } from './shard-model.js';

/** Stable id of the synthetic catch-all shard that owns files under no unit. */
export const ROOT_SHARD_ID = ':root';

/** A shard boundary derived from discovery: where a unit lives + its config anchor. */
export interface ShardBoundary {
  /** Stable unit id (e.g. `pkg:core`). MUST NOT be {@link ROOT_SHARD_ID}. */
  readonly id: string;
  /** Absolute root dir the unit's files live under. */
  readonly rootDir: string;
  /** Absolute config anchor (tsconfig.json) for the unit, if any. */
  readonly configPathAbs?: string;
}

/** Inputs to {@link partitionFilesIntoShards}. */
export interface PartitionInput {
  /** The canonical (fixture-excluded) project-wide file set — absolute paths. */
  readonly canonicalFiles: readonly string[];
  /** Unit boundaries from discovery (rootDir + config anchor). */
  readonly units: readonly ShardBoundary[];
  /** Absolute project root — the synthetic root shard's rootDir. */
  readonly projectRoot: string;
  /** Absolute root config anchor (root tsconfig.json), threaded onto the root shard. */
  readonly rootConfigPathAbs?: string;
}

/**
 * True when `dir` is a path-prefix of `file` at a SEGMENT boundary — i.e. `file`
 * is `dir` itself or lives under it. Avoids the `/foo` ⊂ `/foobar` false match
 * by requiring the prefix to end at a `/` boundary.
 */
function isUnderDir(file: string, dir: string): boolean {
  if (file === dir) return true;
  const withSlash = dir.endsWith('/') ? dir : `${dir}/`;
  return file.startsWith(withSlash);
}

/** A unit boundary with its rootDir pre-normalized to POSIX for prefix math. */
interface NormUnit {
  readonly unit: ShardBoundary;
  readonly rootPosix: string;
}

/**
 * Find the unit whose rootDir is the LONGEST matching prefix of `filePosix`, or
 * `undefined` when the file is under no unit (→ the synthetic root shard).
 */
function longestMatchingUnitId(
  filePosix: string,
  normUnits: readonly NormUnit[],
): string | undefined {
  let bestId: string | undefined;
  let bestLen = -1;
  for (const { unit, rootPosix } of normUnits) {
    if (isUnderDir(filePosix, rootPosix) && rootPosix.length > bestLen) {
      bestLen = rootPosix.length;
      bestId = unit.id;
    }
  }
  return bestId;
}

/**
 * Assign each canonical file to the unit whose rootDir is its longest matching
 * prefix; files under no unit go to a synthetic ROOT shard. Returns only
 * non-empty shards. Deterministic: shard order follows the input unit order
 * (root shard last); each shard's files preserve canonical input order.
 */
export function partitionFilesIntoShards(input: PartitionInput): Shard[] {
  const { canonicalFiles, units, projectRoot, rootConfigPathAbs } = input;

  // Pre-normalize unit rootDirs once; index by id to accumulate file buckets.
  const normUnits: NormUnit[] = units.map((u) => ({
    unit: u,
    rootPosix: toPosixPath(u.rootDir),
  }));
  const buckets = new Map<string, string[]>();
  for (const u of units) buckets.set(u.id, []);
  const rootBucket: string[] = [];

  for (const file of canonicalFiles) {
    const bestId = longestMatchingUnitId(toPosixPath(file), normUnits);
    if (bestId === undefined) rootBucket.push(file);
    else buckets.get(bestId)!.push(file);
  }

  const shards: Shard[] = [];
  for (const u of units) {
    const files = buckets.get(u.id)!;
    if (files.length > 0) {
      shards.push({
        id: u.id,
        rootDir: u.rootDir,
        files,
        ...(u.configPathAbs === undefined ? {} : { configPathAbs: u.configPathAbs }),
      });
    }
  }
  if (rootBucket.length > 0) {
    shards.push({
      id: ROOT_SHARD_ID,
      rootDir: projectRoot,
      files: rootBucket,
      ...(rootConfigPathAbs === undefined ? {} : { configPathAbs: rootConfigPathAbs }),
    });
  }
  return shards;
}
