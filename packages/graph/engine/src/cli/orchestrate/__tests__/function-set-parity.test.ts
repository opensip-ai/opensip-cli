/**
 * PARITY of the exact-vs-sharded function set on the canonical file set
 * (graph-sharded-exact-parity, Phase 1). Phase 0 characterized the gap as an
 * expected-fail; Phase 1 unifies discovery on ONE canonical set so both engines
 * see the identical files. This test now asserts that parity GREEN.
 *
 * ── THE PHASE-1 MODEL ──────────────────────────────────────────────────────
 * Both engines start from the SAME project-wide root discovery (the root
 * tsconfig's file set — every `.ts(x)`, fixtures + tests included) and reduce it
 * via the SINGLE canonical filter (`resolveCanonicalFileSet`, which drops
 * `__fixtures__/` and KEEPS real test files). The exact engine analyzes that set
 * directly; the sharded engine PARTITIONS it across unit boundaries via
 * `partitionFilesIntoShards` (files under no unit → synthetic `:root` shard).
 * Because the sharded file set is `union(shard.files)` of a total + disjoint
 * partition of the canonical set, the two engines analyze byte-identical files.
 *
 * ── CANONICAL DECISION (LOCKED, Phase 0) ───────────────────────────────────
 *   - `__fixtures__/` (synthetic test-input code) is EXCLUDED from both engines.
 *   - real test files (`*.test.ts`, `__tests__/`) are KEPT in both (needed for
 *     test-only-reachable + test→production blast/coverage edges).
 *
 * ── FIXTURE (`__fixtures__/function-set-gap/`) ─────────────────────────────
 *   packages/alpha — `src/index.ts` (kept) + `src/__fixtures__/sample.ts`
 *                    (a fixture → EXCLUDED from the canonical set, both engines).
 *   packages/beta  — `src/index.ts` (kept) + `src/__tests__/index.ts`
 *                    (a real test file → KEPT in both engines).
 *   scripts/       — `root-script.ts` outside `packages/**` → under no unit →
 *                    lands in the synthetic `:root` shard (KEPT in both).
 *
 * ── METHOD ─────────────────────────────────────────────────────────────────
 *   The engine layer may not import the real TypeScript graph adapter. So the
 *   root discovery is modeled via `ts.parseJsonConfigFileContent` (the same
 *   primitive that adapter's `discoverFiles` uses), and the canonical filter +
 *   partition are the REAL engine primitives under test
 *   (`resolveCanonicalFileSet`, `partitionFilesIntoShards`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveCanonicalFileSet } from '../canonical-file-set.js';
import { partitionFilesIntoShards, ROOT_SHARD_ID } from '../partition-files.js';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'function-set-gap',
);

/** Workspace units the sharded path discovers: `<root>/packages/*` dirs with a tsconfig. */
const UNIT_DIRS = ['alpha', 'beta'].map((p) => join(FIXTURE_ROOT, 'packages', p));

/** Resolve the ROOT tsconfig's raw file set the way the real TS adapter does. */
function discoverRootFilesAbs(): readonly string[] {
  const tsconfigPath = join(FIXTURE_ROOT, 'tsconfig.json');
  const read = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(`tsconfig read failed: ${tsconfigPath}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath));
  // Mirror the adapter's source-file filter: .ts(x) only, no declaration files.
  return parsed.fileNames.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).sort();
}

function toProjectRel(absFile: string): string {
  const rel = relative(FIXTURE_ROOT, absFile);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * The canonical filter operates over PROJECT-RELATIVE paths here. In the real
 * engine the project root is never itself under a `__fixtures__` segment, so the
 * filter (run on absolute paths) only matches a project's OWN `__fixtures__`
 * trees. This test's FIXTURE_ROOT, however, lives under the engine package's own
 * `__tests__/__fixtures__/` — so filtering its absolute paths would
 * (incorrectly) strip the entire tree. Converting to project-relative paths
 * first reproduces the engine's semantics faithfully: only the fixture's OWN
 * inner `src/__fixtures__/` is dropped, not the project root above it.
 */
function discoverRootFilesRel(): readonly string[] {
  return discoverRootFilesAbs().map(toProjectRel).sort();
}

/**
 * exact engine's canonical set: ONE root discovery → resolveCanonicalFileSet.
 * Models `runGraph`'s `discoverFiles({ cwd })` + canonical filter (orchestrate.ts).
 */
function exactCanonical(): readonly string[] {
  return [...resolveCanonicalFileSet(discoverRootFilesRel())].sort();
}

/**
 * sharded engine's canonical set: the SAME root discovery + canonical filter,
 * then PARTITIONED across unit boundaries (resolveShards, Phase 1). The sharded
 * file set is `union(shard.files)`. Models `partitionFilesIntoShards`.
 *
 * The partition runs over project-relative paths (units' rootDirs are likewise
 * project-relative) so the prefix math is self-consistent with the canonical set.
 */
function shardedCanonicalShards(): ReturnType<typeof partitionFilesIntoShards> {
  const canonicalFiles = resolveCanonicalFileSet(discoverRootFilesRel());
  return partitionFilesIntoShards({
    canonicalFiles,
    units: UNIT_DIRS.map((rootDir) => {
      const rel = toProjectRel(rootDir);
      return {
        id: `pkg:${rel.replace('packages/', '')}`,
        rootDir: rel,
        configPathAbs: `${rel}/tsconfig.json`,
      };
    }),
    projectRoot: '',
    rootConfigPathAbs: 'tsconfig.json',
  });
}

function shardedCanonical(): readonly string[] {
  return shardedCanonicalShards()
    .flatMap((s) => s.files)
    .sort();
}

/**
 * Derive the function set from a file set. Each fixture source declares exactly
 * one `export function <name>()`; extracting it grounds the function-set identity
 * (`filePath::name`) in real content, mirroring the walk's "one occurrence per
 * declared function."
 */
function functionSetOf(filesProjectRel: readonly string[]): string[] {
  const set: string[] = [];
  for (const rel of filesProjectRel) {
    const text = readFileSync(join(FIXTURE_ROOT, rel), 'utf8');
    const m = /export\s+function\s+([A-Za-z_]\w*)\(/.exec(text);
    if (m?.[1]) set.push(`${rel}::${m[1]}`);
  }
  return set.sort();
}

describe('graph sharded-vs-exact function-set parity (canonical set)', () => {
  it('the partition is total + disjoint over the canonical set', () => {
    const canonical = [...resolveCanonicalFileSet(discoverRootFilesRel())].sort();
    const shards = shardedCanonicalShards();
    const partitioned = shards.flatMap((s) => s.files).sort();
    // union(shard.files) === canonicalFiles (no file dropped, none invented).
    expect(partitioned).toEqual(canonical);
    // disjoint: every file in exactly one shard (no duplicates across shards).
    expect(new Set(partitioned).size).toBe(partitioned.length);
  });

  it('the root script (under no unit) lands in the synthetic :root shard', () => {
    const shards = shardedCanonicalShards();
    const rootShard = shards.find((s) => s.id === ROOT_SHARD_ID);
    expect(rootShard).toBeDefined();
    expect(rootShard?.files).toContain('scripts/root-script.ts');
    // It is anchored at the project root + root tsconfig so it parses correctly.
    expect(rootShard?.rootDir).toBe('');
    expect(rootShard?.configPathAbs).toBe('tsconfig.json');
  });

  it('sharded and exact discover the same canonical FILE set', () => {
    expect(shardedCanonical()).toEqual(exactCanonical());
  });

  it('sharded and exact produce the same canonical FUNCTION set', () => {
    expect(functionSetOf(shardedCanonical())).toEqual(functionSetOf(exactCanonical()));
  });

  it('NEITHER engine includes any /__fixtures__/ path', () => {
    expect(exactCanonical().some((f) => f.includes('/__fixtures__/'))).toBe(false);
    expect(shardedCanonical().some((f) => f.includes('/__fixtures__/'))).toBe(false);
    // The fixture file specifically is gone from both.
    expect(exactCanonical()).not.toContain('packages/alpha/src/__fixtures__/sample.ts');
    expect(shardedCanonical()).not.toContain('packages/alpha/src/__fixtures__/sample.ts');
  });

  it('BOTH engines keep real test files (test → production edges depend on them)', () => {
    expect(exactCanonical()).toContain('packages/beta/src/__tests__/index.ts');
    expect(shardedCanonical()).toContain('packages/beta/src/__tests__/index.ts');
  });
});
