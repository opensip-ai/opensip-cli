/**
 * Flat-monorepo discovery strategy — Phase 12 of opensip's substrate
 * consolidation (opensip DEC-498).
 *
 * Phase 0 Q4 audit determined that a flat monorepo of >2500 .ts files
 * cannot run on the engine in single-process mode:
 *   - `heap-preflight.ts` caps elevation at 12 GB (`HEAP_TARGETS`
 *     fileThreshold=2500 → heapMb=12288).
 *   - `--packages` fan-out (see `packages-runner.ts`) depends on
 *     workspace boundaries — `discoverWorkspacePackages` walks
 *     `<cwd>/packages/**` looking for `tsconfig.json`. A flat directory
 *     has no such boundaries; the strategy is structurally inapplicable.
 *
 * This module ships the partition strategy. It is intentionally
 * subprocess-free: callers supply file lists (real or synthetic for
 * tests), and the partition primitives are pure. Wiring to
 * `runPackagesInParallel` lives in `graph.ts` — at the CLI dispatch
 * layer, where the subprocess shape (cliScript, displayPath rendering)
 * already exists.
 *
 * Cross-partition fidelity: identical to the existing `--packages`
 * trade-off — cross-partition call sites become unresolved (catalog
 * renderer emits them with `toQualifiedNameUnresolved`). A future
 * follow-up may tag partition-boundary edges with
 * `partition_boundary: true` metadata; out of scope for v1.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Layout classification — three buckets that drive the strategy choice
 * in `selectStrategyForLayout`.
 *
 * - **workspaces:** at least one nested `package.json` OR root
 *   `package.json` declares `workspaces`. Existing `--packages` fan-out
 *   handles it.
 * - **flat-small:** no workspace structure, file count ≤ threshold.
 *   Single-process mode + heap-preflight elevation handles it.
 * - **flat-large:** no workspace structure, file count > threshold.
 *   Must synthetically partition; no single-process mode can hold the
 *   `ts.Program` in 12 GB.
 */
export type MonorepoLayout =
  | { readonly kind: 'workspaces'; readonly packageDirs: readonly string[] }
  | { readonly kind: 'flat-small'; readonly files: readonly string[] }
  | { readonly kind: 'flat-large'; readonly files: readonly string[] };

/**
 * Synthetic partition — the unit that gets handed to a child process in
 * the flat-large fan-out. `id` is suitable as a display label and a
 * cache-key segment; `files` are absolute paths.
 */
export interface SyntheticPartition {
  readonly id: string;
  readonly files: readonly string[];
}

export type PartitionStrategy = 'directory-depth' | 'file-count-chunks' | 'hybrid';

/** Default elevation threshold — mirrors `heap-preflight.ts` HEAP_TARGETS top tier. */
const DEFAULT_HEAP_ELEVATION_THRESHOLD = 2500;
/** Default partitioning depth for the `directory-depth` strategy. */
const DEFAULT_DIRECTORY_DEPTH = 2;
/**
 * Default chunk size for `file-count-chunks` and `hybrid` sub-partitioning.
 * Chosen at 2000 to stay well below the 2500-file heap-elevation
 * threshold — each partition runs in a child process with a default V8
 * heap (no elevation needed at this size).
 */
const DEFAULT_CHUNK_SIZE = 2000;

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.turbo',
  'coverage',
  '.next',
]);

export interface DetectMonorepoLayoutInput {
  readonly repoRoot: string;
  /**
   * Source-file count threshold above which a no-workspace layout is
   * classified `flat-large`. Default 2500 (matches `heap-preflight.ts`
   * top elevation tier).
   */
  readonly heapElevationThreshold?: number;
  /**
   * Optional injection for tests — pre-computed file list. When set, the
   * walker is skipped entirely. Production callers leave undefined.
   */
  readonly files?: readonly string[];
  /**
   * Optional injection for tests — pre-computed nested package.json
   * directory list. When set, filesystem walking for workspace
   * detection is skipped.
   */
  readonly nestedPackageDirs?: readonly string[];
  /**
   * Optional injection for tests — root package.json contents. When set,
   * the on-disk root package.json read is skipped.
   */
  readonly rootPackageJson?: { readonly workspaces?: unknown } | null;
}

/**
 * Classify a repository's layout. Walks `<repoRoot>` for nested
 * `package.json` files (one and two levels deep — `<root>/*` and
 * `<root>/packages/*` — matching the conventions
 * `discoverWorkspacePackages` already supports) and the root
 * `package.json` for `workspaces`.
 *
 * - Multiple nested package.json OR root `workspaces` → `'workspaces'`.
 * - No workspace structure + .ts(x)/.js(x) count ≤ threshold →
 *   `'flat-small'`.
 * - No workspace structure + count > threshold → `'flat-large'`.
 *
 * Test injection: callers may supply `files`, `nestedPackageDirs`, or
 * `rootPackageJson` to skip the filesystem walk. Production callers
 * leave these undefined.
 */
export function detectMonorepoLayout(input: DetectMonorepoLayoutInput): MonorepoLayout {
  const threshold = input.heapElevationThreshold ?? DEFAULT_HEAP_ELEVATION_THRESHOLD;
  const nestedPackageDirs = input.nestedPackageDirs ?? findNestedPackageDirs(input.repoRoot);
  const rootPkg = input.rootPackageJson === undefined
    ? readRootPackageJson(input.repoRoot)
    : input.rootPackageJson;
  const hasWorkspaces = nestedPackageDirs.length > 0
    || (Array.isArray(rootPkg?.workspaces) && rootPkg.workspaces.length > 0);

  if (hasWorkspaces) {
    return { kind: 'workspaces', packageDirs: nestedPackageDirs };
  }

  const files = input.files ?? findSourceFiles(input.repoRoot);
  return files.length > threshold
    ? { kind: 'flat-large', files }
    : { kind: 'flat-small', files };
}

export interface PartitionFlatRepoInput {
  readonly files: readonly string[];
  readonly repoRoot: string;
  readonly strategy: PartitionStrategy;
  /** Directory depth for `'directory-depth'`. Default 2. */
  readonly depth?: number;
  /** Chunk size for `'file-count-chunks'` and `'hybrid'`. Default 2000. */
  readonly chunkSize?: number;
}

/**
 * Partition a flat file list into synthetic packages.
 *
 * Strategies:
 *
 * - **`directory-depth`** (default depth=2): bucket files by their
 *   first N path segments under `repoRoot`. Partition IDs join the
 *   segments with `.` (e.g., `src/api/foo.ts` at depth=2 → partition
 *   `src.api`). Edge cases:
 *   - Files shallower than `depth` (e.g., `src/foo.ts` at depth=2)
 *     bucket under their actual depth — partition `src` here.
 *   - Files directly at `repoRoot` (e.g., `foo.ts`) bucket under
 *     `_root`. (Underscore prefix avoids collision with a real
 *     top-level directory named `root`.)
 *   - Files outside `repoRoot` (`..` segments) bucket under `_external`
 *     — should be rare; usually a sign of a malformed input.
 *
 * - **`file-count-chunks`**: sort alphabetically (stable), split into
 *   chunks of `chunkSize`. Partition IDs `chunk-0`, `chunk-1`, …
 *   Worst semantic quality (no directory coherence) but works on any
 *   layout — used as the fallback inside `hybrid` and as a flag-driven
 *   override.
 *
 * - **`hybrid`** (recommended default for `flat-large`): apply
 *   `directory-depth` first; if any single partition exceeds
 *   `chunkSize`, sub-partition that partition using `file-count-chunks`.
 *   Sub-partition IDs concatenate: `<parent>.chunk-N`. Preserves
 *   directory coherence where the structure helps, falls back to
 *   chunking where one directory dominates.
 *
 * Sorted output: partition IDs are returned in stable lexicographic
 * order; files within each partition are sorted lexicographically.
 * Determinism matters for cache keys and reproducible runs.
 */
export function partitionFlatRepo(input: PartitionFlatRepoInput): readonly SyntheticPartition[] {
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0) {
    throw new Error('partitionFlatRepo: chunkSize must be > 0');
  }

  if (input.strategy === 'file-count-chunks') {
    return chunkByCount(input.files, chunkSize);
  }
  if (input.strategy === 'directory-depth') {
    const depth = input.depth ?? DEFAULT_DIRECTORY_DEPTH;
    return chunkByDirectoryDepth(input.files, input.repoRoot, depth);
  }
  // hybrid
  const depth = input.depth ?? DEFAULT_DIRECTORY_DEPTH;
  const byDirectory = chunkByDirectoryDepth(input.files, input.repoRoot, depth);
  const out: SyntheticPartition[] = [];
  for (const partition of byDirectory) {
    if (partition.files.length <= chunkSize) {
      out.push(partition);
      continue;
    }
    const subChunks = chunkByCount(partition.files, chunkSize);
    for (const sub of subChunks) {
      out.push({
        id: `${partition.id}.${sub.id}`,
        files: sub.files,
      });
    }
  }
  return out;
}

export interface StrategySelection {
  readonly mode: 'single-process' | 'packages-fanout' | 'synthetic-partition';
  readonly partitionStrategy?: PartitionStrategy;
}

/**
 * Choose the orchestration mode for a detected layout.
 *
 * - `workspaces` → `packages-fanout` (existing path; `graph.ts`
 *   delegates to `runPackagesInParallel`).
 * - `flat-small` → `single-process` (current default; heap-preflight
 *   handles elevation if needed).
 * - `flat-large` → `synthetic-partition` with `hybrid` strategy
 *   (recommended default per Phase 12 audit).
 */
export function selectStrategyForLayout(layout: MonorepoLayout): StrategySelection {
  if (layout.kind === 'workspaces') return { mode: 'packages-fanout' };
  if (layout.kind === 'flat-small') return { mode: 'single-process' };
  return { mode: 'synthetic-partition', partitionStrategy: 'hybrid' };
}

// ---------- private helpers ----------

function chunkByCount(
  files: readonly string[],
  chunkSize: number,
): readonly SyntheticPartition[] {
  const sorted = [...files].sort();
  const out: SyntheticPartition[] = [];
  for (let i = 0; i < sorted.length; i += chunkSize) {
    out.push({
      id: `chunk-${String(out.length)}`,
      files: sorted.slice(i, i + chunkSize),
    });
  }
  return out;
}

function chunkByDirectoryDepth(
  files: readonly string[],
  repoRoot: string,
  depth: number,
): readonly SyntheticPartition[] {
  if (depth < 1) {
    throw new Error('chunkByDirectoryDepth: depth must be >= 1');
  }
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const id = partitionIdFor(file, repoRoot, depth);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = [];
      buckets.set(id, bucket);
    }
    bucket.push(file);
  }
  const ids = [...buckets.keys()].sort();
  return ids.map((id) => {
    const bucketFiles = buckets.get(id);
    // istanbul ignore next — id was just enumerated from buckets.keys()
    const list = bucketFiles ?? [];
    return { id, files: [...list].sort() };
  });
}

/**
 * Derive a partition ID from a file path. Joins the first `depth` path
 * segments under `repoRoot` with `.`. Shallower files fall into their
 * actual-depth partition; the repo-root file falls into `_root`; files
 * outside `repoRoot` fall into `_external`.
 */
function partitionIdFor(file: string, repoRoot: string, depth: number): string {
  const rel = relative(repoRoot, file);
  if (rel === '' || rel === '.') return '_root';
  if (rel.startsWith('..')) return '_external';
  const segments = rel.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return '_root';
  // Last segment is the filename — exclude from the directory prefix.
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return '_root';
  const prefix = dirSegments.slice(0, depth);
  return prefix.join('.');
}

/**
 * Walk `<repoRoot>/*` and `<repoRoot>/packages/*` looking for nested
 * `package.json` files. Returns the directories that contain them.
 * Matches the conventions `discoverWorkspacePackages` already supports
 * — broader detection (e.g., `apps/*`, `services/*`) is unnecessary
 * because any of those layouts will also be caught by a root
 * `workspaces` declaration.
 */
function findNestedPackageDirs(repoRoot: string): readonly string[] {
  if (!safeIsDir(repoRoot)) return [];
  const out: string[] = [];
  // Direct children: <root>/<pkg>/package.json
  collectImmediatePackageDirs(repoRoot, out);
  // packages/* layer: <root>/packages/<pkg>/package.json
  const packagesDir = join(repoRoot, 'packages');
  if (safeIsDir(packagesDir)) {
    collectImmediatePackageDirs(packagesDir, out);
  }
  out.sort();
  return out;
}

function collectImmediatePackageDirs(dir: string, out: string[]): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry)) continue;
    const sub = join(dir, entry);
    if (!safeIsDir(sub)) continue;
    if (existsSync(join(sub, 'package.json'))) {
      out.push(sub);
    }
  }
}

function readRootPackageJson(
  repoRoot: string,
): { readonly workspaces?: unknown } | null {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as { readonly workspaces?: unknown };
  } catch {
    return null;
  }
}

/**
 * Walk `<repoRoot>` recursively collecting source files. Used only when
 * the caller does not inject a pre-computed `files` list. Skips
 * `node_modules`, `dist`, `build`, and other common artifact dirs.
 */
function findSourceFiles(repoRoot: string): readonly string[] {
  if (!safeIsDir(repoRoot)) return [];
  const out: string[] = [];
  walk(repoRoot);
  out.sort();
  return out;

  function walk(dir: string): void {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIR_NAMES.has(entry)) continue;
      const sub = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(sub).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(sub);
        continue;
      }
      if (hasSourceExtension(entry)) {
        out.push(sub);
      }
    }
  }
}

function hasSourceExtension(filename: string): boolean {
  for (const ext of SOURCE_EXTENSIONS) {
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
