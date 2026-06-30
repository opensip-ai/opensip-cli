/**
 * @fileoverview Targeted behavior fixture suite for the lowest-coverage checks.
 *
 * These tests exercise specific analyze()/analyzeAll() branches that the
 * broad fixture-driven suites don't reach:
 *  - database-index-coverage: where-clause + raw-query violation arms
 *  - package-json-exports-field: relative-path filtering + violation push
 *  - missing-type-exports: undeclared deep-import violation + barrel fallback
 *  - typescript-frontend: real tsc run that emits parseable errors
 *  - display/index: getCheckIcon/getCheckDisplayName known + fallback paths
 *
 * The analyzeAll checks filter `files.paths` on `packages/` / `services/`
 * prefixes, so the fixtures are written under a temp root that we `chdir`
 * into and the checks are run with RELATIVE `targetFiles` — the engine's
 * FileAccessor then resolves `files.read('packages/...')` against cwd.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeNullSafety } from '../checks/quality/data-integrity/null-safety.js';
import { analyzeFileForToctou } from '../checks/quality/patterns/toctou-race-condition.js';
import { analyzeCallbackInvocationSafe } from '../checks/resilience/callback-invocation-safe.js';
import { analyzeContextLeakage } from '../checks/resilience/context-leakage.js';
import { analyzeSqlInjection } from '../checks/security/sql-injection.js';
import { getCheckDisplayName, getCheckIcon } from '../display/index.js';
import { checks } from '../index.js';

import type { CheckResult, CheckViolation } from '@opensip-cli/fitness';

// Production simulation: register the TS adapter (see behavior-fixtures.test.ts).
const langRegistry = new LanguageRegistry();
langRegistry.register(typescriptAdapter);
const testScope = new RunScope({ languages: langRegistry });
// Bind the scope cache to the test-only singleton these tests prewarm:
// check.run resolves currentScope()?.fitness?.fileCache now (Phase 1).
Object.assign(testScope, { fitness: { fileCache } });

// The vitest process cwd is the checks-typescript package dir; captured at
// module load so the tsc fixture can locate the monorepo root reliably even
// after other suites chdir into temp roots.
const originalCwdAtModuleLoad = process.cwd();

let root: string;
let originalCwd: string;

function findCheck(slug: string) {
  const c = checks.find((x) => x.config.slug === slug);
  if (!c) throw new Error(`check not found: ${slug}`);
  return c;
}

/** Write a file at a path relative to the temp root. */
function fx(rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** Build N leaf modules under `src/<prefix>/` and return their absolute paths. */
function buildLeaves(prefix: string, count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    paths.push(fx(`src/${prefix}/leaf${i}.ts`, `export const v${i} = ${i}`));
  }
  return paths;
}

/** Produce `count` relative import statements targeting the leaf modules. */
function importLines(prefix: string, count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`import { v${i} } from "./${prefix}/leaf${i}.js"`);
  }
  return lines.join('\n');
}

/**
 * Run a check with RELATIVE target paths. We chdir into the temp root and
 * prewarm/read relative paths so the analyzeAll path-prefix filters match.
 */
async function runRelative(slug: string, relPaths: string[]): Promise<CheckResult> {
  const check = findCheck(slug);
  await fileCache.prewarm(root, ['**/*']);
  return runWithScope(testScope, () => check.run(root, { targetFiles: relPaths }));
}

/** Run a check with absolute target paths (analyze-mode checks). */
async function runAbsolute(slug: string, absPaths: string[]): Promise<CheckResult> {
  const check = findCheck(slug);
  await fileCache.prewarm(root, ['**/*']);
  return runWithScope(testScope, () => check.run(root, { targetFiles: absPaths }));
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'opensip-cov-push-'));
});

afterEach(() => {
  fileCache.clear();
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// database-index-coverage — analyze() arms (analyze-mode, absolute paths)
// ===========================================================================

describe('database-index-coverage — analyze branches', () => {
  it('returns nothing for non-repository files', async () => {
    const abs = fx('src/services/foo.ts', `repo.find({ where: { description: 'x' } })`);
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a find() where-clause referencing an unindexed risky column', async () => {
    const abs = fx(
      'src/database/user-repository.ts',
      [
        'export class UserRepository {',
        '  load(repo: any) {',
        "    return repo.find({ where: { description: 'abc' } })",
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some((s) => s.message.includes('description'))).toBe(true);
  });

  it('does NOT flag a find() where-clause on an indexed column', async () => {
    const abs = fx(
      'src/repositories/account.repository.ts',
      `export const f = (repo: any) => repo.findOne({ where: { id: 1 } })`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });

  it('skips find() calls whose first argument is not an object literal', async () => {
    const abs = fx(
      'src/repositories/x.repository.ts',
      `export const f = (repo: any, opts: any) => repo.find(opts)`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });

  it('skips find() calls with an object that has no where property', async () => {
    const abs = fx(
      'src/repositories/x.repository.ts',
      `export const f = (repo: any) => repo.find({ take: 5 })`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a raw query() using LIKE with a leading wildcard', async () => {
    const abs = fx(
      'src/database/search.ts',
      String.raw`export const f = (db: any) => db.query("SELECT id FROM t WHERE name LIKE '%abc%'")`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals.some((s) => s.message.includes('LIKE'))).toBe(true);
  });

  it('flags an unbounded SELECT * query() with no LIMIT', async () => {
    const abs = fx(
      'src/database/dump.ts',
      String.raw`export const f = (db: any) => db.query("SELECT * FROM users")`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals.some((s) => s.message.includes('SELECT *'))).toBe(true);
  });

  it('does NOT flag SELECT * when bounded by LIMIT', async () => {
    const abs = fx(
      'src/database/dump2.ts',
      String.raw`export const f = (db: any) => db.query("SELECT * FROM users LIMIT 10")`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals.some((s) => s.message.includes('SELECT *'))).toBe(false);
  });

  it('skips raw query() whose argument is not a string literal', async () => {
    const abs = fx(
      'src/database/dynamic.ts',
      `export const f = (db: any, sql: string) => db.query(sql)`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });

  it('ignores method calls that are neither find nor raw query methods', async () => {
    const abs = fx(
      'src/repositories/x.repository.ts',
      `export const f = (repo: any) => repo.save({ description: 'x' })`,
    );
    const result = await runAbsolute('database-index-coverage', [abs]);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// package-json-exports-field — analyzeAll relative-path filtering
// ===========================================================================

describe('package-json-exports-field — analyzeAll branches', () => {
  it('flags a packages/* package.json missing an exports field', async () => {
    fx('packages/foo/package.json', JSON.stringify({ name: '@scope/foo', version: '1.0.0' }));
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', ['packages/foo/package.json']);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('@scope/foo');
  });

  it('does NOT flag a packages/* package with an exports field', async () => {
    fx(
      'packages/bar/package.json',
      JSON.stringify({
        name: '@scope/bar',
        exports: { '.': './dist/index.js' },
      }),
    );
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', ['packages/bar/package.json']);
    expect(result.signals).toHaveLength(0);
  });

  it('skips a private services/* package that is not under packages/', async () => {
    fx('services/api/package.json', JSON.stringify({ name: '@scope/api', private: true }));
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', ['services/api/package.json']);
    expect(result.signals).toHaveLength(0);
  });

  it('still flags a services/* package that is not private and lacks exports', async () => {
    fx('services/api/package.json', JSON.stringify({ name: '@scope/api' }));
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', ['services/api/package.json']);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('@scope/api');
  });

  it('falls back to the file path when the package has no name', async () => {
    fx('packages/anon/package.json', JSON.stringify({ version: '1.0.0' }));
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', ['packages/anon/package.json']);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('packages/anon/package.json');
  });

  it('ignores root, node_modules, and non-package.json paths', async () => {
    fx('package.json', JSON.stringify({ name: 'root' }));
    fx('packages/x/node_modules/dep/package.json', JSON.stringify({ name: 'dep' }));
    fx('packages/x/src/index.ts', 'export const x = 1');
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', [
      'package.json',
      'packages/x/node_modules/dep/package.json',
      'packages/x/src/index.ts',
    ]);
    expect(result.signals).toHaveLength(0);
  });

  it('skips package.json files that are not valid JSON', async () => {
    fx('packages/broken/package.json', '{ not valid json');
    process.chdir(root);
    const result = await runRelative('package-json-exports-field', [
      'packages/broken/package.json',
    ]);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// missing-type-exports — analyzeAll undeclared deep-import detection
// ===========================================================================

describe('missing-type-exports — analyzeAll branches', () => {
  it('flags a deep import of a subpath not declared in the package exports map', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify({
        name: '@scope/foo',
        exports: { '.': './dist/index.js' },
      }),
    );
    fx(
      'packages/consumer/src/uses.ts',
      [
        'import type { Internal } from "@scope/foo/internal"',
        'export const x: Internal = {} as Internal',
      ].join('\n'),
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', ['packages/consumer/src/uses.ts']);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('@scope/foo');
  });

  it('does NOT flag a deep import that IS declared as a subpath export', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify({
        name: '@scope/foo',
        exports: { '.': './dist/index.js', './internal': './dist/internal.js' },
      }),
    );
    fx(
      'packages/consumer/src/uses.ts',
      'import { thing } from "@scope/foo/internal"\nexport const y = thing',
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', ['packages/consumer/src/uses.ts']);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a deep import matching a wildcard subpath export', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify({
        name: '@scope/foo',
        exports: { './plugins/*': './dist/plugins/*.js' },
      }),
    );
    fx(
      'packages/consumer/src/uses.ts',
      'import { p } from "@scope/foo/plugins/alpha"\nexport const z = p',
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', ['packages/consumer/src/uses.ts']);
    expect(result.signals).toHaveLength(0);
  });

  it('treats a name re-exported by some barrel as public when the package has no exports map', async () => {
    fx('packages/foo/package.json', JSON.stringify({ name: '@scope/foo' }));
    fx('packages/foo/src/index.ts', 'export { PublicThing } from "./public.js"');
    fx(
      'packages/consumer/src/uses.ts',
      'import { PublicThing } from "@scope/foo/deep"\nexport const w = PublicThing',
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', [
      'packages/foo/src/index.ts',
      'packages/consumer/src/uses.ts',
    ]);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a deep import whose name is not surfaced by any barrel and has no exports map', async () => {
    fx('packages/foo/package.json', JSON.stringify({ name: '@scope/foo' }));
    fx('packages/foo/src/index.ts', 'export const Unrelated = 1');
    fx(
      'packages/consumer/src/uses.ts',
      'import { Hidden } from "@scope/foo/deep"\nexport const u = Hidden',
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', [
      'packages/foo/src/index.ts',
      'packages/consumer/src/uses.ts',
    ]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('Hidden');
  });

  it('ignores root imports, relative imports, test files, and dist paths', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify({
        name: '@scope/foo',
        exports: { '.': './dist/index.js' },
      }),
    );
    fx('packages/consumer/src/root.ts', 'import { a } from "@scope/foo"\nexport const r = a');
    fx('packages/consumer/src/rel.ts', 'import { b } from "./local"\nexport const s = b');
    fx(
      'packages/consumer/src/uses.test.ts',
      'import { c } from "@scope/foo/deep"\nexport const t = c',
    );
    fx('packages/consumer/dist/uses.ts', 'import { d } from "@scope/foo/deep"\nexport const v = d');
    process.chdir(root);
    const result = await runRelative('missing-type-exports', [
      'packages/consumer/src/root.ts',
      'packages/consumer/src/rel.ts',
      'packages/consumer/src/uses.test.ts',
      'packages/consumer/dist/uses.ts',
    ]);
    expect(result.signals).toHaveLength(0);
  });

  it('handles the conditional-only exports shorthand (root is public)', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify({
        name: '@scope/foo',
        exports: { import: './dist/index.js', default: './dist/index.cjs' },
      }),
    );
    fx(
      'packages/consumer/src/uses.ts',
      'import { deep } from "@scope/foo/deep"\nexport const q = deep',
    );
    process.chdir(root);
    const result = await runRelative('missing-type-exports', ['packages/consumer/src/uses.ts']);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('deep');
  });
});

// ===========================================================================
// typescript-frontend — real tsc run emitting parseable errors
// ===========================================================================

describe('typescript-frontend — analyzeAll over a real app fixture', () => {
  // The check shells out to `npx tsc --noEmit` inside each app directory,
  // and `findRepoRoot` walks up from the first file path until it finds an
  // `apps/` directory. For `npx tsc` to resolve the real compiler we must
  // sit inside this monorepo's node_modules tree, so the fixture lives in a
  // uniquely-named `apps/<id>/` under the repo root and is cleaned up after.
  const repoRoot = join(originalCwdAtModuleLoad, '..', '..', '..');
  let appsDir: string;

  beforeEach(() => {
    // Remove any cov-tsf-* fixtures a prior *interrupted* run left behind (the
    // afterEach below cleans up on normal completion, but SIGINT bypasses it).
    // We also prune an empty `apps/` parent (which this test may create via
    // recursive mkdir) so that `pnpm test` / `pnpm fit` runs never leave an
    // empty apps/ directory in the project root.
    // This keeps the working tree — and a subsequent `pnpm fit` — free of stale
    // detritus that would otherwise be analyzed as real source.
    const appsRoot = join(repoRoot, 'apps');
    try {
      if (existsSync(appsRoot)) {
        let hasNonCov = false;
        for (const entry of readdirSync(appsRoot)) {
          if (entry.startsWith('cov-tsf-')) {
            rmSync(join(appsRoot, entry), { recursive: true, force: true });
          } else if (!entry.startsWith('.')) {
            hasNonCov = true;
          }
        }
        if (!hasNonCov) {
          // After cleaning only our temp subdirs, the parent is now empty.
          // Remove it so we don't leave an empty apps/ behind from prior runs.
          try {
            rmSync(appsRoot, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // apps/ may not exist yet — nothing to clean.
    }
    appsDir = join(repoRoot, 'apps', `cov-tsf-${process.pid}-${Date.now()}`);
    mkdirSync(join(appsDir, 'src'), { recursive: true });
    writeFileSync(
      join(appsDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: [],
          moduleResolution: 'node',
        },
        include: ['src'],
      }),
    );
    writeFileSync(join(appsDir, 'src', 'index.ts'), 'export const n: number = "not a number"\n');
  });

  afterEach(() => {
    rmSync(appsDir, { recursive: true, force: true });
    // Remove the temp `apps/` dir if it is now empty (we may have created the
    // parent as a side-effect of the recursive mkdir for the fixture).
    // Only remove if empty to avoid touching a real apps/ layout a user has.
    const appsRoot = join(repoRoot, 'apps');
    try {
      if (existsSync(appsRoot)) {
        const entries = readdirSync(appsRoot).filter((e) => !e.startsWith('.'));
        if (entries.length === 0) {
          rmSync(appsRoot, { recursive: true, force: true });
        }
      }
    } catch {
      // apps/ may be non-empty (a real one) or removal failed — leave it.
    }
  });

  it('reports TypeScript compilation errors parsed from tsc output', async () => {
    const fileA = join(appsDir, 'src', 'index.ts');
    const check = findCheck('typescript-frontend');
    const result = await runWithScope(testScope, () =>
      check.run(repoRoot, { targetFiles: [fileA] }),
    );

    expect(result.signals.length).toBeGreaterThan(0);
    // Errors are parsed from `tsc` output into per-error signals carrying a
    // typescript.tv suggestion (the parseErrors → errorsToViolations path).
    const tsErr = result.signals.find((s) => s.suggestion?.includes('typescript.tv'));
    expect(tsErr).toBeDefined();
    expect(tsErr?.message).toMatch(/TS\d+/);
  }, 120_000);
});

// ===========================================================================
// null-safety — direct analyzeNullSafety skip arms
// ===========================================================================

function runNullSafety(content: string, path = 'packages/x/src/svc.ts'): CheckViolation[] {
  return runWithScopeSync(testScope, () => analyzeNullSafety(content, path));
}

describe('null-safety — analyze branches', () => {
  const run = runNullSafety;

  it('flags an unguarded property access on an element-access result', () => {
    const v = run('export const name = items[0].displayName');
    expect(v.some((x) => x.message.includes('displayName'))).toBe(true);
  });

  it('does NOT flag property access guarded by an enclosing && on the base', () => {
    const v = run('export const name = items[0] && items[0].displayName');
    expect(v.some((x) => x.message.includes('displayName'))).toBe(false);
  });

  it('does NOT flag property access guarded by a ternary condition', () => {
    const v = run('export const name = items[0] ? items[0].displayName : fallback');
    expect(v.some((x) => x.message.includes('displayName'))).toBe(false);
  });

  it('does NOT flag property access originating from this', () => {
    const src = ['export class C {', '  read() { return this.pick().displayName }', '}'].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag access to a safe member like length on an element-access base', () => {
    const v = run('export const n = items[0].length');
    expect(v.some((x) => x.message.includes('length'))).toBe(false);
  });

  it('does NOT flag a line already using optional chaining elsewhere', () => {
    const v = run('export const name = items[0]?.displayName ?? items[0].displayName');
    expect(v).toHaveLength(0);
  });

  it('skips files on a safe-by-construction null path (*-schema.ts)', () => {
    const v = run('export const name = items[0].displayName', 'packages/x/src/user-schema.ts');
    expect(v).toHaveLength(0);
  });
});

// ===========================================================================
// error-handling-quality — analyze() catch/Result violation arms
// ===========================================================================

async function runErrorHandling(src: string, rel = 'packages/x/src/svc.ts'): Promise<CheckResult> {
  const abs = fx(rel, src);
  return runAbsolute('error-handling-quality', [abs]);
}

describe('error-handling-quality — analyze branches', () => {
  const run = runErrorHandling;

  it('skips test files', async () => {
    const src = 'export function f() { try { work() } catch (e) {} }';
    const result = await run(src, 'packages/x/src/svc.test.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without catch/isErr/.match( (quick filter)', async () => {
    const result = await run('export const x = 1');
    expect(result.signals).toHaveLength(0);
  });

  it('flags an empty catch block', async () => {
    const src = 'export function f() { try { work() } catch (e) {} }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.toLowerCase().includes('catch'))).toBe(true);
  });

  it('flags a catch block that silently returns a sentinel value', async () => {
    const src = 'export function f() { try { return work() } catch (e) { return null } }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Catch returns null'))).toBe(true);
  });

  it('does NOT flag a catch block that logs the error', async () => {
    const src = 'export function f() { try { work() } catch (e) { logger.warn(e) } }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a catch block that re-throws', async () => {
    const src = 'export function f() { try { work() } catch (e) { throw e } }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a Result.isErr() branch that silently returns a sentinel', async () => {
    const src = [
      'export function f(r: any) {',
      '  if (r.isErr()) { return false }',
      '  return r.value',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('silently discarded'))).toBe(true);
  });

  it('flags a mapErr() callback that does not log', async () => {
    // The quick filter requires a catch/isErr/.match( token; the logging
    // catch satisfies it without contributing a violation of its own.
    const src = [
      'export function f(result: any) {',
      '  try { warmup() } catch (e) { logger.warn(e) }',
      '  return result.mapErr((e: any) => defaultValue)',
      '}',
    ].join('\n');
    const out = await run(src);
    expect(out.signals.some((s) => s.message.includes('mapErr'))).toBe(true);
  });

  it('flags a match() error handler that does not log', async () => {
    const src = 'export const out = result.match((v: any) => v, (e: any) => fallback)';
    const out = await run(src);
    expect(out.signals.some((s) => s.message.includes('match'))).toBe(true);
  });

  it('flags an unsafe `as Error` cast in a catch without an instanceof guard', async () => {
    const src = 'export function f() { try { work() } catch (e) { report((e as Error).message) } }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('as Error'))).toBe(true);
  });

  it('does NOT flag an `as Error` cast guarded by instanceof Error', async () => {
    const src =
      'export function f() { try { work() } catch (e) { if (e instanceof Error) report((e as Error).message) } }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('as Error'))).toBe(false);
  });
});

// ===========================================================================
// sql-injection — direct analyzeSqlInjection tagged-template arms
// ===========================================================================

function analyzeSql(src: string): readonly { line: number; message: string }[] {
  return analyzeSqlInjection(src, 'packages/x/src/repo.ts');
}

describe('sql-injection — analyze branches', () => {
  const analyze = analyzeSql;

  it('flags a raw query with template interpolation', () => {
    const src =
      'export const r = (db: any, id: string) => db.query(`SELECT * FROM users WHERE id = ${id}`)';
    expect(analyze(src).some((v) => v.message.includes('SQL injection'))).toBe(true);
  });

  it('does NOT flag a safe `sql` tagged template', () => {
    const src = 'export const r = (id: string) => sql`SELECT * FROM users WHERE id = ${id}`';
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag a safe property-access tagged template (db.sql`...`)', () => {
    const src =
      'export const r = (db: any, id: string) => db.sql`SELECT * FROM users WHERE id = ${id}`';
    expect(analyze(src)).toHaveLength(0);
  });

  it('truncates the match text for a very long interpolated query', () => {
    const filler = 'x'.repeat(260);
    const src = `export const r = (db: any, id: string) => db.query(\`SELECT ${filler} FROM users WHERE id = \${id}\`)`;
    const out = analyze(src);
    expect(out.some((v) => v.message.includes('SQL injection'))).toBe(true);
  });
});

// ===========================================================================
// database-schema-validation — analyze() TypeORM entity arms
// ===========================================================================

describe('database-schema-validation — analyze branches', () => {
  const P = 'packages/x/src/user.entity.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('database-schema-validation', [abs]);
  }

  it('skips non-entity files', async () => {
    const src = '@Entity()\nexport class User { @Column() name!: string }';
    const result = await run(src, 'packages/x/src/user.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips entity-path files that contain no @Entity/@Table decorator', async () => {
    const result = await run('export class User { name!: string }');
    expect(result.signals).toHaveLength(0);
  });

  it('flags an entity missing a primary key and audit columns', async () => {
    const src = ['@Entity()', 'export class User {', '  @Column() name!: string', '}'].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.toLowerCase().includes('primary'))).toBe(true);
    expect(result.signals.some((s) => /createdAt|updatedAt/i.test(s.message))).toBe(true);
  });

  it('reports only the missing updatedAt audit column when createdAt exists', async () => {
    const src = [
      '@Entity()',
      'export class User {',
      '  @PrimaryGeneratedColumn() id!: number',
      '  @CreateDateColumn() createdAt!: Date',
      '  @Column() name!: string',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('updatedAt'))).toBe(true);
  });

  it('does NOT flag a complete entity (PK + both audit columns)', async () => {
    const src = [
      '@Entity()',
      'export class User {',
      '  @PrimaryGeneratedColumn() id!: number',
      '  @CreateDateColumn() createdAt!: Date',
      '  @UpdateDateColumn() updatedAt!: Date',
      '  @Column() name!: string',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a nullable column declared without a default', async () => {
    const src = [
      '@Entity()',
      'export class User {',
      '  @PrimaryGeneratedColumn() id!: number',
      '  @CreateDateColumn() createdAt!: Date',
      '  @UpdateDateColumn() updatedAt!: Date',
      '  @Column({ nullable: true }) nickname?: string',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.toLowerCase().includes('nullable'))).toBe(true);
  });
});

// ===========================================================================
// context-leakage — direct analyzeContextLeakage branches
// ===========================================================================

describe('context-leakage — analyze branches', () => {
  const P = 'packages/x/src/state.ts';
  function run(content: string, path = P): CheckViolation[] {
    return analyzeContextLeakage(content, path);
  }

  it('skips test files', () => {
    expect(
      run('let activeContext: RequestContext | null = null', 'packages/x/src/state.test.ts'),
    ).toHaveLength(0);
  });

  it('skips files under dbos/steps/', () => {
    expect(
      run('let activeContext: RequestContext | null = null', 'packages/x/src/dbos/steps/s.ts'),
    ).toHaveLength(0);
  });

  it('flags a module-level let with a *Context type', () => {
    const v = run('let activeContext: RequestContext | null = null');
    expect(v).toHaveLength(1);
    expect(v[0]?.match).toContain('activeContext');
  });

  it('does NOT flag a const binding', () => {
    expect(run('const activeContext: RequestContext = build()')).toHaveLength(0);
  });

  it('does NOT flag an AsyncLocalStorage-typed binding', () => {
    expect(
      run('let store: AsyncLocalStorage<RequestContext> = new AsyncLocalStorage()'),
    ).toHaveLength(0);
  });

  it('does NOT flag a lazy-init metric instrument', () => {
    expect(run('let requestCounter: Counter | null = null')).toHaveLength(0);
  });

  it('does NOT flag an OTel-imported Context type', () => {
    const src = [
      'import { Context } from "@opentelemetry/api"',
      'let parentContext: Context | null = null',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag a non-contextual, non-typed let', () => {
    expect(run('let total: number = 0')).toHaveLength(0);
  });

  it('does NOT flag a name-only contextual signal without a contextual type', () => {
    expect(run('let requestCount: number = 0')).toHaveLength(0);
  });

  it('flags a non-readonly context field in a request-scoped class', () => {
    const src = [
      'export class Handler {',
      '  current!: RequestContext',
      '  handle(tenantId: string) { return tenantId }',
      '}',
    ].join('\n');
    const v = run(src);
    expect(v.some((f) => f.match?.includes('current'))).toBe(true);
  });

  it('does NOT flag a readonly context field', () => {
    const src = [
      'export class Handler {',
      '  readonly current!: RequestContext',
      '  handle(tenantId: string) { return tenantId }',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag context fields on a class that is not request-scoped', () => {
    const src = [
      'export class Plain {',
      '  current!: RequestContext',
      '  compute(x: number) { return x }',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });
});

// ===========================================================================
// throws-documentation — analyze() detection + skip arms
// ===========================================================================

describe('throws-documentation — analyze branches', () => {
  const P = 'packages/x/src/svc.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('throws-documentation', [abs]);
  }

  it('skips test files', async () => {
    const src = 'export function f() { throw new Error("x") }';
    const result = await run(src, 'packages/x/src/svc.test.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without a throw statement (quick filter)', async () => {
    const result = await run('export function f() { return 1 }');
    expect(result.signals).toHaveLength(0);
  });

  it('flags a function that throws a plain Error without @throws JSDoc', async () => {
    const src = 'export function risky() { throw new Error("boom") }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('@throws'))).toBe(true);
  });

  it('does NOT flag a function that already has @throws JSDoc', async () => {
    const src = [
      '/** @throws {Error} when it fails */',
      'export function risky() { throw new Error("boom") }',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'risky'"))).toBe(false);
  });

  it('does NOT flag a throw of a self-documenting typed error', async () => {
    const src = 'export function risky() { throw new ValidationError("bad") }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'risky'"))).toBe(false);
  });

  it('does NOT flag a bare re-throw of a caught error variable', async () => {
    const src = [
      'export function risky() {',
      '  try { work() } catch (err) { throw err }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'risky'"))).toBe(false);
  });

  it('does NOT flag an anonymous arrow callback that throws', async () => {
    const src = 'export const out = list.map(() => { throw new Error("x") })';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a class method that throws a plain Error', async () => {
    const src = ['export class C {', '  doWork() { throw new Error("fail") }', '}'].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'doWork'"))).toBe(true);
  });
});

// ===========================================================================
// result-pattern-consistency — analyze() throw + skip arms
// ===========================================================================

describe('result-pattern-consistency — analyze branches', () => {
  const P = 'packages/x/src/logic.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('result-pattern-consistency', [abs]);
  }

  it('skips files without throw or Result (quick filter)', async () => {
    const result = await run('export const x = 1');
    expect(result.signals).toHaveLength(0);
  });

  it('flags a bare throw of an expected ValidationError', async () => {
    const src = 'export function doIt() { throw new ValidationError("bad") }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Throwing ValidationError'))).toBe(true);
  });

  it('skips throws in throw-allowed paths like /routes/', async () => {
    const src = 'export function doIt() { throw new ValidationError("bad") }';
    const result = await run(src, 'packages/x/src/routes/logic.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips throws in infrastructure files (e.g. *-registry.ts)', async () => {
    const src = 'export function doIt() { throw new NotFoundError("missing") }';
    const result = await run(src, 'packages/x/src/plugin-registry.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips re-throws inside a catch block', async () => {
    const src = [
      'export function doIt() {',
      '  try { work() } catch (e) { throw new ValidationError("wrap") }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('skips throws inside a constructor', async () => {
    const src = [
      'export class C {',
      '  constructor(n: number) { if (n < 0) throw new ValidationError("neg") }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('skips throws inside a private method', async () => {
    const src = [
      'export class C {',
      '  private guard() { throw new ValidationError("x") }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('skips throws inside a validation-helper function (validateXxx)', async () => {
    const src = 'export function validateInput() { throw new ValidationError("x") }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a throw of a non-expected error type', async () => {
    const src = 'export function doIt() { throw new TypeError("boom") }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('flags a Result-returning function that throws an expected error', async () => {
    const src = [
      'export function load(id: string): Result<Row, ValidationError> {',
      '  if (!id) throw new ValidationError("missing id")',
      '  return ok(fetch(id))',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('returns Result but throws'))).toBe(true);
  });

  it('flags a throw inside a non-private class method (containing-function name via method arm)', async () => {
    const src = ['export class C {', '  doWork() { throw new NotFoundError("missing") }', '}'].join(
      '\n',
    );
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Throwing NotFoundError'))).toBe(true);
  });

  it('flags a throw inside an arrow function assigned to a const', async () => {
    const src = 'export const handle = () => { throw new ConflictError("dup") }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Throwing ConflictError'))).toBe(true);
  });

  it('skips a private method that returns Result and throws (private-method body arm)', async () => {
    const src = [
      'export class C {',
      '  private compute(): Result<number, ValidationError> {',
      '    throw new ValidationError("x")',
      '  }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('returns Result but throws'))).toBe(false);
  });

  it('skips a Result-returning validation helper that throws (funcName arm)', async () => {
    const src = [
      'export function validateRow(): Result<Row, ValidationError> {',
      '  throw new ValidationError("x")',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('returns Result but throws'))).toBe(false);
  });
});

// ===========================================================================
// stubbed-implementation-detection — analyze() pattern + skip arms
// ===========================================================================

describe('stubbed-implementation-detection — analyze branches', () => {
  const P = 'packages/x/src/svc.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('stubbed-implementation-detection', [abs]);
  }

  it('flags an empty object stub cast to a non-primitive type', async () => {
    const src = 'export function make(): Widget { return {} as Widget }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Empty object stub'))).toBe(true);
  });

  it('does NOT flag an empty object cast to a primitive', async () => {
    const src = 'export function make() { return {} as unknown }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Empty object stub'))).toBe(false);
  });

  it('does NOT flag an empty object cast to a Record type', async () => {
    const src = 'export function make() { return {} as Record<string, number> }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Empty object stub'))).toBe(false);
  });

  it('does NOT flag an empty object cast to a generic type parameter', async () => {
    const src = 'export function make<T>(): T { return {} as T }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Empty object stub'))).toBe(false);
  });

  it('does NOT flag an empty object cast used as a Proxy target', async () => {
    const src = 'export function make(): Widget { return new Proxy({} as Widget, {}) }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Empty object stub'))).toBe(false);
  });

  it('flags a Promise.resolve() placeholder return', async () => {
    const src = 'export async function fetchData() { return Promise.resolve(null) }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Promise.resolve'))).toBe(true);
  });

  it('does NOT flag Promise.resolve() in a lifecycle method', async () => {
    const src = [
      'export class Svc {',
      '  async dispose() { return Promise.resolve(undefined) }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Promise.resolve'))).toBe(false);
  });

  it('does NOT flag Promise.resolve() inside a conditional guard', async () => {
    const src = [
      'export async function fetchData(skip: boolean) {',
      '  if (skip) { return Promise.resolve(null) }',
      '  return realWork()',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Promise.resolve'))).toBe(false);
  });

  it('does NOT flag Promise.resolve() when the body has substantive statements', async () => {
    const src = [
      'export async function fetchData() {',
      '  const x = computeStuff()',
      '  return Promise.resolve(null)',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Promise.resolve'))).toBe(false);
  });

  it('flags a hardcoded { success: true, data: [] } stub return', async () => {
    const src = 'export function list() { return { success: true, data: [] } }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Hardcoded stub return'))).toBe(true);
  });

  it('does NOT flag a hardcoded stub return inside a conditional branch', async () => {
    const src = [
      'export function list(empty: boolean) {',
      '  if (empty) { return { success: true, data: [] } }',
      '  return { success: true, data: fetchRows() }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Hardcoded stub return'))).toBe(false);
  });

  it('does NOT flag a hardcoded stub return when calls precede it', async () => {
    const src = [
      'export function list() {',
      '  doSetup()',
      '  return { success: true, data: [] }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Hardcoded stub return'))).toBe(false);
  });

  it('flags a placeholder comment', async () => {
    const src = 'export function todo() {\n  // STUB: implement this\n  return 0\n}';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Placeholder comment'))).toBe(true);
  });

  it('skips all AST stub detection in test files', async () => {
    const src = 'export function make(): Widget { return {} as Widget }';
    const result = await run(src, 'packages/x/src/svc.test.ts');
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// numeric-validation — analyze() parse-call + parameter arms
// ===========================================================================

describe('numeric-validation — analyze branches', () => {
  const P = 'packages/x/src/calc.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('numeric-validation', [abs]);
  }

  it('skips test files', async () => {
    const result = await run('export const n = parseInt(input, 10)', 'packages/x/src/calc.test.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips route handler files', async () => {
    const result = await run(
      'export const n = parseInt(input, 10)',
      'packages/x/src/routes/calc.ts',
    );
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without any numeric keyword (quick filter)', async () => {
    const result = await run('export const s = "hello"');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files that import zod', async () => {
    const src = 'import { z } from "zod"\nexport const n = parseInt(input, 10)';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('flags an unvalidated parseInt call', async () => {
    const src = 'export function f(input: string) { const n = parseInt(input, 10); return n }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(true);
  });

  it('does NOT flag parseInt with a "|| 0" fallback on the same line', async () => {
    const src = 'export function f(input: string) { const n = parseInt(input, 10) || 0; return n }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag parseInt when a Number.isFinite check follows nearby', async () => {
    const src = [
      'export function f(input: string) {',
      '  const n = parseInt(input, 10)',
      '  if (!Number.isFinite(n)) throw new Error("bad")',
      '  return n',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag parseInt of a DynamoDB .N attribute', async () => {
    const src = 'export function f(item: any) { const n = parseInt(item.count.N, 10); return n }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag parseInt with a safe numeric-string fallback in the argument', async () => {
    const src =
      "export function f(input?: string) { const n = parseInt(input ?? '0', 10); return n }";
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag parseInt when a regex digit guard precedes it', async () => {
    const src = [
      'export function f(input: string) {',
      String.raw`  if (/^\d+$/.test(input)) {`,
      '    const n = parseInt(input, 10)',
      '    return n',
      '  }',
      '  return 0',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag parseInt of a regex capture subscript with a nearby digit regex', async () => {
    const src = [
      'export function f(text: string) {',
      String.raw`  const re = /(\d+)/`,
      '  const m = re.exec(text)',
      '  const n = parseInt(m[1], 10)',
      '  return n',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parseInt'))).toBe(false);
  });

  it('does NOT flag a primitive `number` keyword parameter (only type references named number)', async () => {
    // The TS AST models `: number` as a NumberKeyword node, not a
    // TypeReferenceNode, so isNumberTypeParam returns false — exercising the
    // parameter-filter no-match arm without producing a violation.
    const src = 'export function area(width: number) { return width * 2 }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'width'"))).toBe(false);
  });

  it('does NOT flag a number param that has a default value', async () => {
    const src = 'export function area(width: number = 1) { return width * 2 }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'width'"))).toBe(false);
  });

  it('does NOT flag a number param named like a safe loop counter', async () => {
    const src = 'export function loop(index: number) { return index }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'index'"))).toBe(false);
  });

  it('does NOT flag a number param when the body validates it', async () => {
    const src =
      'export function area(width: number) { if (!Number.isFinite(width)) throw new Error("x"); return width }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'width'"))).toBe(false);
  });

  it('does NOT flag a private (_-prefixed) function with a number param', async () => {
    const src = 'export function _internal(width: number) { return width * 2 }';
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'width'"))).toBe(false);
  });

  it('does NOT flag a private method with a number param', async () => {
    const src = [
      'export class C {',
      '  private compute(width: number) { return width * 2 }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes("'width'"))).toBe(false);
  });
});

// ===========================================================================
// silent-early-returns — analyze() exemption arms
// ===========================================================================

describe('silent-early-returns — analyze branches', () => {
  const P = 'packages/x/src/biz.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('silent-early-returns', [abs]);
  }

  it('skips files without any return null/false (quick filter)', async () => {
    const result = await run('export function f() { return 1 }');
    expect(result.signals).toHaveLength(0);
  });

  it('flags a non-guard function with a silent return null', async () => {
    const src = [
      'export function loadThing(cfg: any) {',
      '  doStuff()',
      '  doMore()',
      '  doEvenMore()',
      '  if (!cfg.ready) return null',
      '  return cfg',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Silent early return'))).toBe(true);
  });

  it('flags a silent return false in a then-block', async () => {
    const src = [
      'export function flow(cfg: any) {',
      '  doStuff()',
      '  doMore()',
      '  doEvenMore()',
      '  if (!cfg.ok) { return false }',
      '  return true',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('Silent early return (false)'))).toBe(
      true,
    );
  });

  it('does NOT flag a type-guard function (x is T return type)', async () => {
    const src =
      'export function check(x: unknown): x is string { if (typeof x !== "string") return false; return true }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a predicate-prefixed function (isXxx)', async () => {
    const src = 'export function isReady(x: any) { if (!x) return false; return true }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag explicit boolean contracts where false is the outcome', async () => {
    const src = [
      'export function appendOnce(items: string[], name: string): boolean {',
      '  doA()',
      '  doB()',
      '  doC()',
      '  if (items.includes(name)) return false',
      '  items.push(name)',
      '  return true',
      '}',
      'export async function grewClosure(size: number): Promise<boolean> {',
      '  doA()',
      '  doB()',
      '  doC()',
      '  if (size === 0) return false',
      '  return true',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a function whose return type is T | null', async () => {
    const src =
      'export function lookupRow(x: any): Row | null { doA(); doB(); if (!x) return null; return x }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a predicate callback in arr.filter', async () => {
    const src = 'export const out = arr.filter((x: any) => { if (!x) return false; return true })';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag an early guard clause in the first 3 statements', async () => {
    const src = 'export function compute(cfg: any) { if (!cfg) return null; return work(cfg) }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag when logging is present near the return', async () => {
    const src = [
      'export function flow(cfg: any) {',
      '  doStuff()',
      '  doMore()',
      '  doEvenMore()',
      '  if (!cfg.ok) { logger.warn("not ok"); return null }',
      '  return cfg',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// missing-input-validation — analyze() handler-detection arms
// ===========================================================================

describe('missing-input-validation — analyze branches', () => {
  const P = 'packages/api/src/routes/handler.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('missing-input-validation', [abs]);
  }

  it('skips excluded internal paths like /services/', async () => {
    const src = 'export function h(req: any, res: any) { return res.send(req.body) }';
    const result = await run(src, 'packages/api/src/services/handler.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without any handler-shaped keyword (quick filter)', async () => {
    const result = await run('export const x = 1');
    expect(result.signals).toHaveLength(0);
  });

  it('flags an Express (req, res) handler with no validation', async () => {
    const src = 'export function createUser(req: any, res: any) { return res.send(req.body) }';
    const result = await run(src);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain("'createUser'");
  });

  it('flags a Fastify (request, reply) arrow handler assigned to a const', async () => {
    const src =
      'export const createUser = (request: any, reply: any) => { return reply.send(request.body) }';
    const result = await run(src);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain("'createUser'");
  });

  it('does NOT flag a handler that validates with .parse()', async () => {
    const src =
      'export function h(req: any, res: any) { const d = schema.parse(req.body); return res.send(d) }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a method whose first two params are not request/response', async () => {
    const src = [
      'export class C {',
      '  handler(first: number, second: number) { return first + second }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a handler whose parameters are destructured (non-identifier)', async () => {
    const src = 'export function h({ req }: any, { res }: any) { return req }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a single-parameter function', async () => {
    const src = 'export function h(req: any) { return req.body }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// fastify-route-validation — analyze() validation-detection arms
// ===========================================================================

describe('fastify-route-validation — analyze branches', () => {
  const P = 'packages/api/src/routes/users.ts';
  async function run(src: string, rel = P): Promise<CheckResult> {
    const abs = fx(rel, src);
    return runAbsolute('fastify-route-validation', [abs]);
  }

  it('skips files not under /routes/', async () => {
    const src = 'fastify.post("/u", async (req, reply) => { req.body })';
    const result = await run(src, 'packages/api/src/handlers/users.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without any fastify route pattern (quick filter)', async () => {
    const result = await run('export const x = 1');
    expect(result.signals).toHaveLength(0);
  });

  it('flags a POST handler that reads request.body without validation', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.post("/users", async (request, reply) => {',
      '    const data = request.body',
      '    return reply.send(data)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.message).toContain('POST /users');
  });

  it('does NOT flag a handler that validates with Zod .parse()', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.put("/users", async (request, reply) => {',
      '    const data = schema.parse(request.body)',
      '    return reply.send(data)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a handler using an alternative validateBody() validator', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.patch("/users", async (request, reply) => {',
      '    const data = validateBody(request.body)',
      '    return reply.send(data)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a handler with manual if-! body validation', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.post("/users", async (request, reply) => {',
      '    const body = request.body',
      '    if (!body) return reply.code(400).send()',
      '    return reply.send(body)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a handler that returns a 400 with an Invalid message', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.post("/users", async (request, reply) => {',
      '    if (bad(request.body)) return reply.code(400).send({ error: "Invalid input" })',
      '    return reply.send(ok)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a route passing a zod schema in the options object', async () => {
    const src = [
      'export function reg(fastify: any) {',
      '  fastify.post("/users", { schema: { body: userSchema } }, async (request, reply) => {',
      '    return reply.send(request.body)',
      '  })',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('uses content-level fallback when no handler function is present', async () => {
    // No inline handler arrow — the route options reference a named handler.
    // checkForValidation falls back to hasValidationInContent: zod + .parse(.
    const src = [
      'import { z } from "zod"',
      'const userSchema = z.object({})',
      'export function reg(fastify: any) {',
      '  fastify.post("/users", { handler: namedHandler })',
      '}',
      'function namedHandler(request: any) { return userSchema.parse(request.body) }',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('skips a route call with fewer than two arguments', async () => {
    const src = 'export function reg(fastify: any) { fastify.post("/users") }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// toctou-race-condition — direct analyzeFileForToctou branches
// ===========================================================================

describe('toctou-race-condition — analyze branches', () => {
  const P = 'packages/x/src/account-service.ts';
  function run(content: string, path = P): CheckViolation[] {
    // analyzeFileForToctou reads recipe config via currentScope().
    return runWithScopeSync(testScope, () => analyzeFileForToctou(path, content));
  }

  it('flags a shared read-then-update on the same receiver', () => {
    const src = [
      'export async function applyDelta(store: any) {',
      '  const current = await store.get(key)',
      '  await store.update({ ...current, n: current.n + 1 })',
      '}',
    ].join('\n');
    const v = run(src);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('read-then-update');
    expect(v[0]?.match).toBe('applyDelta');
  });

  it('skips files in a safe TOCTOU path (e.g. /cache/)', () => {
    const src = [
      'export async function applyDelta(store: any) {',
      '  const current = await store.get(key)',
      '  await store.update(current)',
      '}',
    ].join('\n');
    expect(run(src, 'packages/x/src/cache/store.ts')).toHaveLength(0);
  });

  it('skips a function documenting atomic / transaction semantics', () => {
    const src = [
      'export async function applyDelta(store: any) {',
      '  // uses withTransaction for atomicity',
      '  const current = await store.get(key)',
      '  await store.update(current)',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag read-then-update on a local Map parameter', () => {
    const src = [
      'export function bump(counts: Map<string, number>) {',
      '  const current = counts.get(key)',
      '  counts.set(key, (current ?? 0) + 1)',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag read-then-update on a local `new Map()` variable', () => {
    const src = [
      'export function bump() {',
      '  const counts = new Map()',
      '  const current = counts.get(key)',
      '  counts.set(key, current)',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag access to a this.<name>Cache class field', () => {
    const src = [
      'export class Svc {',
      '  private headerCache = new Map()',
      '  async load(key: string) {',
      '    const hit = this.headerCache.get(key)',
      '    this.headerCache.set(key, hit)',
      '  }',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag a drizzle-style atomic write (db.update(table))', () => {
    const src = [
      'export async function touch(db: any) {',
      '  const row = await db.find(key)',
      '  await db.update(usersTable)',
      '}',
    ].join('\n');
    // db.update is classified atomic-sql-write, so no read-then-update pair.
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag a function with no read/update pair', () => {
    const src = 'export function noop(store: any) { return store.size }';
    expect(run(src)).toHaveLength(0);
  });

  it('does NOT flag interface-typed state-bag Map fields (state.lowlink)', () => {
    const src = [
      'interface State { lowlink: Map<string, number> }',
      'export function step(state: State) {',
      '  const v = state.lowlink.get(key)',
      '  state.lowlink.set(key, v ?? 0)',
      '}',
    ].join('\n');
    expect(run(src)).toHaveLength(0);
  });
});

// ===========================================================================
// callback-invocation-safe — direct analyze branches
// ===========================================================================

describe('callback-invocation-safe — analyze branches', () => {
  const P = 'packages/x/src/notifier.ts';
  function run(content: string, path = P): CheckViolation[] {
    return analyzeCallbackInvocationSafe(content, path);
  }

  it('skips non-.ts, .d.ts, test, and out-of-scope files', () => {
    const c = 'subscribers.forEach((cb) => cb())';
    expect(run(c, 'packages/x/src/n.js')).toHaveLength(0);
    expect(run(c, 'packages/x/src/n.d.ts')).toHaveLength(0);
    expect(run(c, 'packages/x/src/n.test.ts')).toHaveLength(0);
    expect(run(c, 'apps/web/src/n.ts')).toHaveLength(0);
  });

  it('fast-paths files that never mention a collection name', () => {
    expect(run('export const x = 1')).toHaveLength(0);
  });

  it('flags an unguarded subscribers.forEach((cb) => cb())', () => {
    const c = 'export function fire() {\n  subscribers.forEach((cb) => cb(payload))\n}';
    const v = run(c);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('subscribers');
  });

  it('flags an unguarded for-of over listeners', () => {
    const c =
      'export function fire() {\n  for (const cb of this.listeners) {\n    cb(payload)\n  }\n}';
    const v = run(c);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('listeners');
  });

  it('does NOT flag when the forEach body wraps the call in a safe<Name>() helper', () => {
    const c =
      'export function fire() {\n  observers.forEach((cb) => this.safeObserver(cb, payload))\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag a forEach inside a try block', () => {
    const c = [
      'export function fire() {',
      '  try {',
      '    callbacks.forEach((cb) => cb(payload))',
      '  } catch (e) {',
      '    log(e)',
      '  }',
      '}',
    ].join('\n');
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag when the arrow parameter is never invoked in the body', () => {
    const c = 'export function fire() {\n  handlers.forEach((cb) => log("noop"))\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag iteration over a collection whose name is not recognised', () => {
    const c = 'export function fire() {\n  widgets.forEach((cb) => cb(payload))\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('honors a pragma with a rationale on the same line', () => {
    const c =
      'export function fire() {\n  subscribers.forEach((cb) => cb(payload)) // @callback-invocation-safe-by-caller -- caller wraps\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('honors a pragma with a rationale on the line above', () => {
    const c = [
      'export function fire() {',
      '  // @callback-invocation-safe-by-caller -- producer is already inside try',
      '  subscribers.forEach((cb) => cb(payload))',
      '}',
    ].join('\n');
    expect(run(c)).toHaveLength(0);
  });

  it('rejects a BARE pragma with no rationale', () => {
    const c = [
      'export function fire() {',
      '  // @callback-invocation-safe-by-caller',
      '  subscribers.forEach((cb) => cb(payload))',
      '}',
    ].join('\n');
    const v = run(c);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('rationale');
  });

  it('matches scope when packages/ appears mid-path (nested workspace)', () => {
    const c = 'export function fire() {\n  subscribers.forEach((cb) => cb(payload))\n}';
    const v = run(c, 'repo/packages/x/src/notifier.ts');
    expect(v).toHaveLength(1);
  });

  it('does NOT flag a for-of over an unrecognised collection name', () => {
    const c =
      'export function fire() {\n  for (const cb of this.widgets) {\n    cb(payload)\n  }\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag a for-of whose loop variable is never invoked', () => {
    const c = 'export function fire() {\n  for (const cb of listeners) {\n    log(cb)\n  }\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag a for-of whose body uses a safe<Name>() wrapper', () => {
    const c =
      'export function fire() {\n  for (const cb of observers) {\n    this.safeObserver(cb, payload)\n  }\n}';
    expect(run(c)).toHaveLength(0);
  });

  it('does NOT flag a for-of nested inside a try block', () => {
    const c = [
      'export function fire() {',
      '  try {',
      '    for (const cb of callbacks) {',
      '      cb(payload)',
      '    }',
      '  } catch (e) {',
      '    log(e)',
      '  }',
      '}',
    ].join('\n');
    expect(run(c)).toHaveLength(0);
  });

  it('honors a for-of opt-out pragma with a rationale', () => {
    const c = [
      'export function fire() {',
      '  // @callback-invocation-safe-by-caller -- drained inside producer try',
      '  for (const cb of handlers) {',
      '    cb(payload)',
      '  }',
      '}',
    ].join('\n');
    expect(run(c)).toHaveLength(0);
  });
});

// ===========================================================================
// async-waterfall-detection — analyze() skip arms + positive case
// ===========================================================================

async function runWaterfall(src: string, rel = 'src/wf.ts'): Promise<CheckResult> {
  const abs = fx(rel, src);
  return runAbsolute('async-waterfall-detection', [abs]);
}

describe('async-waterfall-detection — analyze branches', () => {
  const run = runWaterfall;

  it('skips files in test paths', async () => {
    const src = 'export async function f() { await a(); await b() }';
    const result = await run(src, 'src/wf.test.ts');
    expect(result.signals).toHaveLength(0);
  });

  it('skips files without any await', async () => {
    const result = await run('export function f() { return 1 }');
    expect(result.signals).toHaveLength(0);
  });

  it('flags two independent consecutive awaits of function calls', async () => {
    // Variable names are chosen NOT to appear as substrings of the next
    // await's text (e.g. avoid single letters that occur in "await").
    const src = [
      'export async function f() {',
      '  const userRow = await loadUser()',
      '  const orgRow = await loadOrg()',
      '  return [userRow, orgRow]',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals.some((s) => s.message.includes('parallelizable'))).toBe(true);
  });

  it('does NOT flag when the second await references the first result', async () => {
    const src = [
      'export async function f() {',
      '  const userRow = await loadUser()',
      '  const orgRow = await loadOrg(userRow)',
      '  return orgRow',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag awaits in different if/else branches', async () => {
    const src = [
      'export async function f(cond: boolean) {',
      '  if (cond) {',
      '    await loadA()',
      '  } else {',
      '    await loadB()',
      '  }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a sleep/delay call paired with another await', async () => {
    const src = ['export async function f() {', '  await sleep(100)', '  await loadB()', '}'].join(
      '\n',
    );
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a lock acquire followed by work', async () => {
    const src = [
      'export async function f(mutex: any) {',
      '  await mutex.acquire()',
      '  await doWork()',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag when the second await uses a destructured binding from the first', async () => {
    const src = [
      'export async function f() {',
      '  const { handler } = await import("./mod.js")',
      '  await handler()',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag when one await is not a function call (bare variable)', async () => {
    const src = [
      'export async function f(pending: Promise<number>) {',
      '  const value = await pending',
      '  const orgRow = await loadOrg()',
      '  return [value, orgRow]',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag awaits in different switch case branches', async () => {
    const src = [
      'export async function f(kind: string) {',
      '  switch (kind) {',
      '    case "a":',
      '      await loadA()',
      '      break',
      '    default:',
      '      await loadB()',
      '  }',
      '}',
    ].join('\n');
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });

  it('does NOT flag a single await with no following await', async () => {
    const src = 'export async function f() { const a = await loadA(); return a }';
    const result = await run(src);
    expect(result.signals).toHaveLength(0);
  });
});

// ===========================================================================
// module-coupling-fan-out — analyzeAll thresholds + barrel/d.ts exemptions
// ===========================================================================

describe('module-coupling-fan-out — analyzeAll branches', () => {
  it('emits an error for >30 imports and a warning for >15, sorted by fan-out', async () => {
    const godLeaves = buildLeaves('god', 31);
    const medLeaves = buildLeaves('med', 16);
    const godUses = godLeaves.map((_, i) => `v${i}`).join(',');
    const medUses = medLeaves.map((_, i) => `v${i}`).join(',');
    const god = fx(
      'src/god-file.ts',
      `${importLines('god', 31)}\nexport const usesAll = [${godUses}]`,
    );
    const med = fx(
      'src/medium-file.ts',
      `${importLines('med', 16)}\nexport const usesAll = [${medUses}]`,
    );

    const result = await runAbsolute('module-coupling-fan-out', [
      god,
      med,
      ...godLeaves,
      ...medLeaves,
    ]);

    // Two violations: god-file (error, fan-out 31) sorts before medium (warning, 16).
    const fanViolations = result.signals.filter((s) => s.message.includes('High fan-out'));
    expect(fanViolations).toHaveLength(2);
    expect(fanViolations[0]?.message).toContain('31');
    expect(fanViolations[1]?.message).toContain('16');
  });

  it('auto-exempts pure barrel files even with high re-export fan-out', async () => {
    const leaves = buildLeaves('barrel', 20);
    const lines = leaves.map((_, i) => `export { v${i} } from "./barrel/leaf${i}.js"`).join('\n');
    const barrel = fx('src/index.ts', lines);

    const result = await runAbsolute('module-coupling-fan-out', [barrel, ...leaves]);
    expect(result.signals.filter((s) => s.message.includes('High fan-out'))).toHaveLength(0);
  });

  it('auto-exempts barrels with only re-exports plus a scope-augmentation side-effect import', async () => {
    const leaves = buildLeaves('pkg', 20);
    const lines = [
      "import './scope-augmentation.js'",
      ...leaves.map((_, i) => `export { v${i} } from "./pkg/leaf${i}.js"`),
    ].join('\n');
    const barrel = fx('packages/graph/engine/src/index.ts', lines);

    const result = await runAbsolute('module-coupling-fan-out', [barrel, ...leaves]);
    expect(result.signals.filter((s) => s.message.includes('High fan-out'))).toHaveLength(0);
  });

  it('auto-exempts .d.ts type-declaration files', async () => {
    const leaves = buildLeaves('types', 18);
    // A .d.ts file with import + non-re-export content so isBarrelFile is false,
    // proving the .d.ts extension branch (not the barrel branch) does the exempting.
    const decl = fx(
      'src/types.d.ts',
      `${importLines('types', 18)}\nexport declare const total: number`,
    );

    const result = await runAbsolute('module-coupling-fan-out', [decl, ...leaves]);
    expect(result.signals.filter((s) => s.message.includes('High fan-out'))).toHaveLength(0);
  });

  it('treats a file with non-re-export top-level statements as a god-file, not a barrel', async () => {
    const leaves = buildLeaves('mix', 16);
    // Mix re-exports with a real const declaration — disqualifies the barrel heuristic.
    const lines = [
      '/* a block comment */',
      '// a line comment',
      ...leaves.map((_, i) => `export { v${i} } from "./mix/leaf${i}.js"`),
      'export const computed = 1',
    ].join('\n');
    const file = fx('src/mixed.ts', lines);

    const result = await runAbsolute('module-coupling-fan-out', [file, ...leaves]);
    expect(result.signals.filter((s) => s.message.includes('High fan-out'))).toHaveLength(1);
  });

  it('does not flag files under the warning threshold', async () => {
    const leaves = buildLeaves('small', 5);
    const file = fx('src/small.ts', `${importLines('small', 5)}\nexport const x = 1`);
    const result = await runAbsolute('module-coupling-fan-out', [file, ...leaves]);
    expect(result.signals.filter((s) => s.message.includes('High fan-out'))).toHaveLength(0);
  });
});

// ===========================================================================
// display/index — icon + display-name lookup and fallback
// ===========================================================================

describe('display/index — getCheckIcon / getCheckDisplayName', () => {
  it('returns the mapped icon and name for a known check slug', () => {
    // circular-import-detection is a real entry in ARCHITECTURE_DISPLAY.
    const icon = getCheckIcon('circular-import-detection');
    const name = getCheckDisplayName('circular-import-detection');
    expect(icon.length).toBeGreaterThan(0);
    expect(name.length).toBeGreaterThan(0);
    // The mapped display name differs from the raw slug.
    expect(name).not.toBe('circular-import-detection');
  });

  it('falls back to a default icon for an unknown check and produces a non-empty name', () => {
    const icon = getCheckIcon('totally-unknown-check-slug');
    const name = getCheckDisplayName('totally-unknown-check-slug');
    expect(icon.length).toBeGreaterThan(0);
    expect(name.length).toBeGreaterThan(0);
  });
});
