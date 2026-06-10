/**
 * CHARACTERIZATION of the exact-vs-sharded function-set gap (graph-sharded-exact
 * -parity, Phase 0). The two graph build engines discover DIFFERENT file sets,
 * so the sharded catalog is missing functions the exact catalog has. This test
 * reproduces the mechanism on a small fixture and PINS it as an expected-fail
 * (`it.fails`) until Phase 1 unifies discovery. It must NOT change engine code.
 *
 * ── EMPIRICAL ROOT CAUSE (Task 0.2, measured on THIS repo via
 *    `node scripts/graph-catalog-diff.mjs`) ─────────────────────────────────
 *
 *   exact   : 15,752 fn occurrences over 1,447 files  (non-module-init)
 *   sharded : 13,537 fn occurrences over 1,134 files
 *   ─────────────────────────────────────────────────────────────────────────
 *   exact_only   : 2,215 occurrences over 313 files
 *   sharded_only :     0 occurrences          ← no visibility/merge artifacts
 *   + module-init: 313 (one synthetic whole-file occurrence per exact-only
 *                  file; the symbol-index dump excludes these)
 *   ≈ TOTAL catalog gap: ~2,528 occurrences  (matches the ~2,700 estimate)
 *
 *   Bucketed cause accounting of the 313 exact_only FILES:
 *     (a) not under any workspace unit's rootDir .................   0 files
 *     (b) under a unit but EXCLUDED by per-unit discovery ........ 313 files
 *           - fixture trees (the __fixtures__ exclude glob) ...... 197 files
 *           - test files (the __tests__ / .test.ts exclude globs)  116 files
 *     (c) duplicate / visibility / merge artifact ...............   0 files
 *     (d) other / unexplained ...................................   0 files
 *
 *   So the discovery-scope hypothesis is CONFIRMED but REFINED: the gap is not
 *   "files outside packages/" (that bucket was empty here) — it is "files under
 *   a package but EXCLUDED by that package's own tsconfig include/exclude."
 *
 * ── WHY (the two discovery paths) ──────────────────────────────────────────
 *
 *   exact   (orchestrate.ts → runGraph): ONE
 *           `adapter.discoverFiles({ cwd: projectRoot })` over the ROOT
 *           tsconfig. The root tsconfig declares no `include`/`exclude`, so
 *           `ts.parseJsonConfigFileContent` defaults to EVERY `.ts(x)` under
 *           the tree — fixtures and tests included.
 *
 *   sharded (graph.ts resolveShards → workspace-units.ts
 *           `discoverTypescriptWorkspaceUnits`): walk `<root>/packages/**` for
 *           dirs with a `tsconfig.json`, then per unit
 *           `adapter.discoverFiles({ cwd: unit.rootDir,
 *           configPathOverride: unit.configPath })`. Per-unit discovery honors
 *           EACH package's own tsconfig, which excludes its __fixtures__ tree
 *           (every check pack) and its __tests__ / .test.ts files
 *           (cli, cli-ui, output, config, session-store). Those files are
 *           therefore in no shard. Files outside the packages tree (root
 *           scripts, .config) would also be dropped — bucket (a) — but this
 *           repo had none in the catalog, so (a) was 0.
 *
 * ── FIXTURE (`__fixtures__/function-set-gap/`) ─────────────────────────────
 *   A two-package tree plus a root script, reproducing all three sub-causes:
 *     packages/alpha  — tsconfig excludes the __fixtures__ tree; contains
 *                       `src/index.ts` (kept) + `src/__fixtures__/sample.ts`
 *                       (sharded-dropped — bucket (b) fixture).
 *     packages/beta   — tsconfig excludes __tests__ + .test.ts; contains
 *                       `src/index.ts` (kept) +
 *                       `src/__tests__/index.ts` (sharded-dropped — bucket (b)
 *                       test).
 *     scripts/        — `root-script.ts` outside `packages/**` entirely
 *                       (sharded-never-discovered — bucket (a)).
 *
 * ── METHOD ─────────────────────────────────────────────────────────────────
 *   The engine layer may not import the real TypeScript graph adapter
 *   (`@opensip-tools/graph-typescript`). Instead this test exercises the SAME
 *   primitive that adapter's `discoverFiles` uses —
 *   `ts.parseJsonConfigFileContent` — to model the two discovery STRATEGIES
 *   faithfully, then derives a function set from the discovered files (one
 *   subject fn per fixture file). The exact-vs-sharded delta this produces is
 *   the same class of gap measured on the real repo above.
 *
 *   Phase 1 fix: "unified file-set sharding" — partition the FULL exact file
 *   set across shards instead of re-deriving each shard's files from the
 *   package tsconfig. When that lands, the two strategies discover the same
 *   files and these `it.fails` assertions flip to passing; remove `.fails`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'function-set-gap',
);

/** Workspace units the sharded path would discover: `<root>/packages/*` dirs with a tsconfig. */
const UNIT_DIRS = ['alpha', 'beta'].map((p) => join(FIXTURE_ROOT, 'packages', p));

/** Resolve a tsconfig's file set the way the real TS adapter does. */
function discoverFilesViaTsconfig(tsconfigPath: string): readonly string[] {
  const read = ts.readConfigFile(tsconfigPath, (p) => ts.sys.readFile(p));
  if (read.error) throw new Error(`tsconfig read failed: ${tsconfigPath}`);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(tsconfigPath),
  );
  // Mirror the adapter's source-file filter: .ts(x) only, no declaration files.
  return parsed.fileNames
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => toProjectRel(f))
    .sort();
}

function toProjectRel(absFile: string): string {
  const rel = relative(FIXTURE_ROOT, absFile);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * exact discovery: ONE pass over the ROOT tsconfig (whole tree). Models
 * `runGraph`'s single `discoverFiles({ cwd: projectRoot })`.
 */
function discoverExact(): readonly string[] {
  return discoverFilesViaTsconfig(join(FIXTURE_ROOT, 'tsconfig.json'));
}

/**
 * sharded discovery: per-workspace-unit, each from its OWN tsconfig. Models
 * `resolveShards` → per-unit `discoverFiles({ cwd: unit.rootDir,
 * configPathOverride: unit.configPath })`. Files outside `packages/**` (the
 * root script) are in no unit and never discovered.
 */
function discoverSharded(): readonly string[] {
  const out = new Set<string>();
  for (const unit of UNIT_DIRS) {
    for (const f of discoverFilesViaTsconfig(join(unit, 'tsconfig.json'))) out.add(f);
  }
  return [...out].sort();
}

/**
 * Derive the function set from a discovered file set. Each fixture source
 * declares exactly one `export function <name>()`; we extract it so the
 * function-set identity (`filePath::name`) is grounded in real file content,
 * mirroring the walk stage's "one occurrence per declared function."
 */
function functionSetOf(files: readonly string[]): string[] {
  const set: string[] = [];
  for (const rel of files) {
    const text = readFileSync(join(FIXTURE_ROOT, rel), 'utf8');
    const m = /export\s+function\s+([A-Za-z_]\w*)\(/.exec(text);
    if (m?.[1]) set.push(`${rel}::${m[1]}`);
  }
  return set.sort();
}

describe('graph sharded-vs-exact function-set parity (characterization)', () => {
  // Guard the FIXTURE itself: the gap must actually reproduce, else the
  // expected-fail below is vacuous. These assert the cause is present.
  it('the fixture reproduces the discovery-scope gap (sanity)', () => {
    const exact = discoverExact();
    const sharded = discoverSharded();
    const exactOnly = exact.filter((f) => !sharded.includes(f));

    // bucket (b) fixture: alpha's __fixtures__ tree is exact-only.
    expect(exactOnly).toContain('packages/alpha/src/__fixtures__/sample.ts');
    // bucket (b) test: beta's __tests__ tree is exact-only.
    expect(exactOnly).toContain('packages/beta/src/__tests__/index.ts');
    // bucket (a): the root script outside packages/** is exact-only.
    expect(exactOnly).toContain('scripts/root-script.ts');
    // sharded_only must be empty (no visibility/merge artifacts — bucket (c)=0).
    expect(sharded.filter((f) => !exact.includes(f))).toEqual([]);
  });

  // THE GAP — expected-fail until Phase 1 unifies discovery. `it.fails` keeps
  // the suite GREEN while documenting the defect (vitest forbids `.skip` here).
  it.fails(
    'sharded and exact discover the same FILE set [FIXED IN PHASE 1: unified file-set sharding]',
    () => {
      expect(discoverSharded()).toEqual(discoverExact());
    },
  );

  it.fails(
    'sharded and exact produce the same FUNCTION set [FIXED IN PHASE 1: unified file-set sharding]',
    () => {
      expect(functionSetOf(discoverSharded())).toEqual(functionSetOf(discoverExact()));
    },
  );
});
