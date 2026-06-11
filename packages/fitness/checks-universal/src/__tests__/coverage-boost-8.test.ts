// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Branch-coverage tests for medium-coverage checks (round 8).
 *
 * Targets the remaining uncovered branches surfaced by the v8 coverage
 * report: the semgrep directive parser, the public-API reachability
 * graph, CSP-header pattern matchers, and several config-consistency
 * analyzers (node/docker version sync, dependency-version drift,
 * duplicate-package detection, performance anti-patterns).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseSemgrepDirectives } from '../checks/documentation/_directives/semgrep.js';
import {
  _resetPublicApiGraphCache,
  isInPublicApiSurface,
} from '../checks/documentation/_public-api-graph.js';
import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov8-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => {
  fileCache.clear();
  _resetPublicApiGraphCache();
});

// =============================================================================
// semgrep directive parser: every rule-id / reason branch
// =============================================================================

describe('parseSemgrepDirectives', () => {
  it('returns no directives for lines without a comment', () => {
    const directives = parseSemgrepDirectives('const x = 1', 'a.ts', 'a.ts');
    expect(directives).toEqual([]);
  });

  it('returns no directives when the comment is not nosemgrep', () => {
    const directives = parseSemgrepDirectives('const x = 1 // just a note', 'a.ts', 'a.ts');
    expect(directives).toEqual([]);
  });

  it('defaults rule to * for a bare nosemgrep', () => {
    const [d] = parseSemgrepDirectives('const x = 1 // nosemgrep', 'a.ts', 'a.ts');
    expect(d?.rule).toBe('semgrep/*');
    expect(d?.reason).toBe('');
  });

  it('captures a rule id after the colon with no reason', () => {
    const [d] = parseSemgrepDirectives('const x = 1 // nosemgrep: rule.id', 'a.ts', 'a.ts');
    expect(d?.rule).toBe('semgrep/rule.id');
    expect(d?.reason).toBe('');
  });

  it('captures both rule id and reason after the colon', () => {
    const [d] = parseSemgrepDirectives(
      'const x = 1 // nosemgrep: rule.id -- validated by zod',
      'a.ts',
      'a.ts',
    );
    expect(d?.rule).toBe('semgrep/rule.id');
    expect(d?.reason).toBe('validated by zod');
  });

  it('falls back to * when colon has an empty rule id before the reason', () => {
    const [d] = parseSemgrepDirectives('const x = 1 // nosemgrep: -- reason here', 'a.ts', 'a.ts');
    expect(d?.rule).toBe('semgrep/*');
    expect(d?.reason).toBe('reason here');
  });

  it('captures a reason with no rule id when -- follows directly', () => {
    const [d] = parseSemgrepDirectives('const x = 1 // nosemgrep -- bare reason', 'a.ts', 'a.ts');
    expect(d?.rule).toBe('semgrep/*');
    expect(d?.reason).toBe('bare reason');
  });

  it('skips a trailing empty line yielded by split', () => {
    // The trailing '\n' yields a final '' entry; the loop must handle it.
    const directives = parseSemgrepDirectives('// nosemgrep\n', 'a.ts', 'a.ts');
    expect(directives).toHaveLength(1);
  });
});

// =============================================================================
// public-API reachability graph: isInPublicApiSurface branches
// =============================================================================

describe('isInPublicApiSurface', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('pubapi');

    // Package A: string exports -> dist/index.js mapped to src/index.ts,
    // which re-exports ./lib.js (named) and ./star.js (star).
    writeFixture(
      cwd,
      'pkg-a/package.json',
      JSON.stringify({
        name: '@org/a',
        exports: './dist/index.js',
      }),
    );
    writeFixture(
      cwd,
      'pkg-a/src/index.ts',
      [
        "export { foo } from './lib.js'",
        "export * from './star.js'",
        "export * as ns from './star-ns.js'",
        "export type { T } from './types.js'",
        "export { bare } from 'some-package'",
      ].join('\n'),
    );
    writeFixture(cwd, 'pkg-a/src/lib.ts', 'export const foo = 1');
    writeFixture(cwd, 'pkg-a/src/star.ts', 'export const star = 1');
    writeFixture(cwd, 'pkg-a/src/star-ns.ts', 'export const ns = 1');
    writeFixture(cwd, 'pkg-a/src/types.ts', 'export type T = number');
    writeFixture(cwd, 'pkg-a/src/internal.ts', 'export const hidden = 1');

    // Package B: conditional + array + subpath exports object.
    writeFixture(
      cwd,
      'pkg-b/package.json',
      JSON.stringify({
        name: '@org/b',
        exports: {
          '.': { import: ['./dist/main.js', './dist/main.js'], require: './dist/main.js' },
          './sub': './dist/sub.js',
          './glob/*': './dist/glob/*.js',
        },
      }),
    );
    writeFixture(cwd, 'pkg-b/src/main.ts', 'export const main = 1');
    writeFixture(cwd, 'pkg-b/src/sub.ts', 'export const sub = 1');

    // Package C: no exports, falls back to module/main fields.
    writeFixture(
      cwd,
      'pkg-c/package.json',
      JSON.stringify({
        name: '@org/c',
        module: './build/entry.js',
        main: './build/entry.js',
      }),
    );
    writeFixture(cwd, 'pkg-c/src/entry.ts', 'export const entry = 1');

    // Package D: binary-only (bin, no exports/main/module) -> empty surface.
    writeFixture(
      cwd,
      'pkg-d/package.json',
      JSON.stringify({
        name: '@org/d',
        bin: { d: './dist/cli.js' },
      }),
    );
    writeFixture(cwd, 'pkg-d/src/cli.ts', 'export const cli = 1');

    // Package E: malformed package.json -> open-fail (everything public).
    writeFixture(cwd, 'pkg-e/package.json', '{ not valid json');
    writeFixture(cwd, 'pkg-e/src/anything.ts', 'export const x = 1');

    // Package F: package.json is a JSON array (not an object) -> open-fail.
    writeFixture(cwd, 'pkg-f/package.json', '[1, 2, 3]');
    writeFixture(cwd, 'pkg-f/src/anything.ts', 'export const x = 1');

    // Package G: exports present but only wildcard -> no entries -> open-fail.
    writeFixture(
      cwd,
      'pkg-g/package.json',
      JSON.stringify({
        name: '@org/g',
        exports: './dist/*.js',
      }),
    );
    writeFixture(cwd, 'pkg-g/src/anything.ts', 'export const x = 1');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('marks re-exported files (named, star, star-as, type) as public', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/index.ts'))).toBe(true);
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/lib.ts'))).toBe(true);
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/star.ts'))).toBe(true);
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/star-ns.ts'))).toBe(true);
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/types.ts'))).toBe(true);
  });

  it('marks files not reachable via re-export as non-public', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-a/src/internal.ts'))).toBe(false);
  });

  it('resolves conditional + array + subpath export objects', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-b/src/main.ts'))).toBe(true);
    expect(isInPublicApiSurface(join(cwd, 'pkg-b/src/sub.ts'))).toBe(true);
  });

  it('falls back to module/main when exports is absent', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-c/src/entry.ts'))).toBe(true);
  });

  it('treats binary-only packages as having an empty public surface', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-d/src/cli.ts'))).toBe(false);
  });

  it('open-fails (everything public) on malformed package.json', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-e/src/anything.ts'))).toBe(true);
  });

  it('open-fails when package.json is not a JSON object', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-f/src/anything.ts'))).toBe(true);
  });

  it('open-fails when only wildcard exports remain', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-g/src/anything.ts'))).toBe(true);
  });

  it('open-fails when no package.json exists above the file', () => {
    const orphan = makeFixtureDir('orphan');
    try {
      // mkdtemp dirs live directly under the OS tmp root, which has no
      // package.json — exercises the findPackageRoot -> undefined path.
      expect(isInPublicApiSurface(join(orphan, 'lonely.ts'))).toBe(true);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// csp-headers: pattern-matcher branches
// =============================================================================

describe('csp-headers patterns', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('csp');
    writeFixture(
      cwd,
      'src/wildcard.ts',
      ['// helmet csp config', 'export const csp = {', "  'script-src': ['*'],", '}'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/missing-default.ts',
      [
        'export const opts = {',
        '  contentSecurityPolicy: {',
        '    directives: {},',
        '  },',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/has-default.ts',
      [
        'export const opts = {',
        '  contentSecurityPolicy: { directives: { defaultSrc: ["\'self\'"] } },',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/data-uri.ts',
      ['// csp helmet', "export const policy = { 'script-src': [\"'self'\", 'data:'] }"].join('\n'),
    );
    writeFixture(cwd, 'src/no-csp.ts', 'export const unrelated = 1');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags wildcard in a CSP directive', async () => {
    const result = await findCheck('csp-headers').run(cwd, {
      targetFiles: [join(cwd, 'src/wildcard.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags contentSecurityPolicy config missing default-src', async () => {
    const result = await findCheck('csp-headers').run(cwd, {
      targetFiles: [join(cwd, 'src/missing-default.ts')],
    });
    const types = result.signals.map((s) => s.message);
    expect(types.some((m) => m.includes('default-src'))).toBe(true);
  });

  it('does not flag a config that already declares default-src', async () => {
    const result = await findCheck('csp-headers').run(cwd, {
      targetFiles: [join(cwd, 'src/has-default.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('missing default-src'))).toBe(false);
  });

  it('flags data: URI in script-src', async () => {
    const result = await findCheck('csp-headers').run(cwd, {
      targetFiles: [join(cwd, 'src/data-uri.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('skips files without CSP references', async () => {
    const result = await findCheck('csp-headers').run(cwd, {
      targetFiles: [join(cwd, 'src/no-csp.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// node-version-consistency: the "matching" (no-violation) branches
// =============================================================================

describe('node-version-consistency matching versions', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('node-match');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify(
        {
          name: 'root',
          engines: { node: '>=24.0.0' },
        },
        null,
        2,
      ),
    );
    // .nvmrc matches the root major -> no nvmrc violation.
    writeFixture(cwd, '.nvmrc', '24');
    // Workspace engines + @types/node match -> no workspace/types violation.
    writeFixture(
      cwd,
      'packages/a/package.json',
      JSON.stringify(
        {
          name: '@org/a',
          engines: { node: '>=24.0.0' },
          devDependencies: { '@types/node': '^24.0.0' },
        },
        null,
        2,
      ),
    );
    // Workspace with NO engines.node -> early return inside checkWorkspaceEngines.
    writeFixture(
      cwd,
      'packages/b/package.json',
      JSON.stringify(
        {
          name: '@org/b',
          dependencies: {},
        },
        null,
        2,
      ),
    );
    // CI workflow node-version matches -> no CI violation.
    writeFixture(
      cwd,
      '.github/workflows/ci.yml',
      ['jobs:', '  test:', '    steps:', "      - run: node-version: '24'"].join('\n'),
    );
    // A non-workflow .yml file -> falls through every else-if.
    writeFixture(cwd, 'config/app.yml', 'setting: value');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('reports no violations when every Node version matches', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('node-version-consistency').run(cwd, {
        targetFiles: [
          join(cwd, 'package.json'),
          join(cwd, '.nvmrc'),
          join(cwd, 'packages/a/package.json'),
          join(cwd, 'packages/b/package.json'),
          join(cwd, '.github/workflows/ci.yml'),
          join(cwd, 'config/app.yml'),
        ],
      });
      expect(result.signals.length).toBe(0);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// =============================================================================
// docker-version-sync: dynamic-pnpm, hardcoded-mismatch, and node-match
// =============================================================================

describe('docker-version-sync dynamic and mismatch', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('docker-sync');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify(
        {
          name: 'root',
          engines: { node: '>=24.0.0' },
          packageManager: 'pnpm@10.0.0+sha512.abc',
        },
        null,
        2,
      ),
    );
    // Dynamic pnpm extraction line -> the PNPM_DYNAMIC_PATTERN true branch.
    writeFixture(
      cwd,
      'Dockerfile',
      [
        'FROM node:24-alpine',
        "RUN corepack prepare pnpm@10.0.0 --activate # require('./package.json').packageManager",
        '',
      ].join('\n'),
    );
    // Node major mismatch + hardcoded pnpm version mismatch.
    writeFixture(
      cwd,
      'Dockerfile.bad',
      ['FROM node:20-alpine', 'RUN corepack prepare pnpm@9.0.0 --activate'].join('\n'),
    );
    // Non-node Dockerfile -> skipped entirely.
    writeFixture(
      cwd,
      'Dockerfile.hasura',
      ['FROM hasura/graphql-engine:latest', 'RUN echo hi'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('does not flag a Dockerfile using dynamic pnpm extraction', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('docker-version-sync').run(cwd, {
        targetFiles: [join(cwd, 'Dockerfile')],
      });
      const types = result.signals.map((s) => s.metadata.type);
      expect(types).not.toContain('pnpm-version-mismatch');
      expect(types).not.toContain('pnpm-hardcoded-version');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('flags both node and pnpm version mismatches', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('docker-version-sync').run(cwd, {
        targetFiles: [join(cwd, 'Dockerfile.bad')],
      });
      const types = result.signals.map((s) => s.metadata.type);
      expect(types).toEqual(
        expect.arrayContaining(['node-version-mismatch', 'pnpm-version-mismatch']),
      );
    } finally {
      process.chdir(origCwd);
    }
  });

  it('skips non-Node Dockerfiles', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('docker-version-sync').run(cwd, {
        targetFiles: [join(cwd, 'Dockerfile.hasura')],
      });
      expect(result.signals.length).toBe(0);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// =============================================================================
// performance-anti-patterns: skip-path and rest-destructuring branches
// =============================================================================

describe('performance-anti-patterns skip paths', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('perf-skip');
    // Inside a fitness check dir -> skipped.
    writeFixture(
      cwd,
      'fitness/src/checks/some-check.ts',
      [
        'export async function f(items: number[]) {',
        '  for (const i of items) { await use(i); }',
        '}',
      ].join('\n'),
    );
    // Diagnostics path -> skipped.
    writeFixture(
      cwd,
      'src/diagnostics/probe.ts',
      [
        'export async function f(items: number[]) {',
        '  for (const i of items) { await use(i); }',
        '}',
      ].join('\n'),
    );
    // @sequential-ok marker -> skipped.
    writeFixture(
      cwd,
      'src/marked.ts',
      [
        '// @sequential-ok intentional sequential processing',
        'export async function f(items: number[]) {',
        '  for (const i of items) { await use(i); }',
        '}',
      ].join('\n'),
    );
    // Rest-destructuring inside a loop should NOT be treated as spread.
    writeFixture(
      cwd,
      'src/rest-destructure.ts',
      [
        'export function f(rows: Record<string, number>[]) {',
        '  const out = [];',
        '  for (const row of rows) {',
        '    const { id, ...rest } = row;',
        '    out.push(rest);',
        '  }',
        '  return out;',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('skips files inside a fitness check directory', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'fitness/src/checks/some-check.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips diagnostics files', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/diagnostics/probe.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files marked @sequential-ok', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/marked.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not flag rest-destructuring as a spread-in-loop', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/rest-destructure.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.toLowerCase().includes('spread'))).toBe(false);
  });
});

// =============================================================================
// performance-anti-patterns: spread-ACCUMULATION precision
//
// The check must flag genuine O(n^2) accumulation (spreading a collection
// back into itself each iteration) while NOT flagging benign in-loop spreads
// — one-time defensive copies, spread call-args, and merges — which were
// previously false positives (and collided with eslint's prefer-spread).
// =============================================================================

describe('performance-anti-patterns spread accumulation', () => {
  let cwd: string;

  function spreadSignals(rel: string): Promise<boolean> {
    return findCheck('performance-anti-patterns')
      .run(cwd, { targetFiles: [join(cwd, rel)] })
      .then((r) => r.signals.some((s) => s.message.toLowerCase().includes('spread')));
  }

  beforeAll(() => {
    cwd = makeFixtureDir('perf-spread');

    // --- ACCUMULATION (must flag) ---
    writeFixture(
      cwd,
      'src/acc-array.ts',
      [
        'export function f(items: number[]): number[] {',
        '  let acc: number[] = [];',
        '  for (const x of items) {',
        '    acc = [...acc, x];', // self-referential array rebuild — O(n^2)
        '  }',
        '  return acc;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/acc-object.ts',
      [
        'export function f(keys: string[]): Record<string, boolean> {',
        '  let state: Record<string, boolean> = {};',
        '  for (const k of keys) {',
        '    state = { ...state, [k]: true };', // self-referential object rebuild
        '  }',
        '  return state;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/acc-map-slot.ts',
      [
        'export function f(rows: { k: string; v: number }[]): Map<string, number[]> {',
        '  const m = new Map<string, number[]>();',
        '  for (const r of rows) {',
        '    m.set(r.k, [...(m.get(r.k) ?? []), r.v]);', // grouping into a Map slot
        '  }',
        '  return m;',
        '}',
      ].join('\n'),
    );

    // --- BENIGN (must NOT flag) ---
    writeFixture(
      cwd,
      'src/copy-then-sort.ts',
      [
        'export function f(groups: number[][]): number[][] {',
        '  const out: number[][] = [];',
        '  for (const g of groups) {',
        '    const sorted = [...g].sort((a, b) => a - b);', // one-time defensive copy
        '    out.push(sorted);',
        '  }',
        '  return out;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/merge.ts',
      [
        'export function f(pairs: [number[], number[]][]): number[][] {',
        '  const out: number[][] = [];',
        '  for (const [a, b] of pairs) {',
        '    const merged = [...a, ...b];', // one-time merge, LHS != either source
        '    out.push(merged);',
        '  }',
        '  return out;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/call-arg.ts',
      [
        'export function f(batches: number[][]): number[] {',
        '  const out: number[] = [];',
        '  for (const batch of batches) {',
        '    out.push(...batch);', // spread call-args — the recommended fix, not a smell
        '  }',
        '  return out;',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags self-referential array accumulation (acc = [...acc, x])', async () => {
    expect(await spreadSignals('src/acc-array.ts')).toBe(true);
  });

  it('flags self-referential object accumulation (state = { ...state, k })', async () => {
    expect(await spreadSignals('src/acc-object.ts')).toBe(true);
  });

  it('flags grouping into a Map slot (m.set(k, [...m.get(k), v]))', async () => {
    expect(await spreadSignals('src/acc-map-slot.ts')).toBe(true);
  });

  it('does NOT flag a one-time defensive copy ([...g].sort())', async () => {
    expect(await spreadSignals('src/copy-then-sort.ts')).toBe(false);
  });

  it('does NOT flag a one-time merge ([...a, ...b])', async () => {
    expect(await spreadSignals('src/merge.ts')).toBe(false);
  });

  it('does NOT flag spread call-arguments (push(...batch))', async () => {
    expect(await spreadSignals('src/call-arg.ts')).toBe(false);
  });
});

// =============================================================================
// dependency-version-consistency: matching, missing-name, and unparseable
// =============================================================================

describe('dependency-version-consistency edge branches', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('dvc-edge');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify(
        {
          name: 'root',
          devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
        },
        null,
        2,
      ),
    );
    // Matches root canonical -> exercises canonical-version match branch.
    writeFixture(
      cwd,
      'packages/a/package.json',
      JSON.stringify(
        {
          name: '@org/a',
          devDependencies: { vitest: '^2.0.0' },
        },
        null,
        2,
      ),
    );
    // No name field -> pkgName falls back to directory basename.
    writeFixture(
      cwd,
      'packages/noname/package.json',
      JSON.stringify(
        {
          devDependencies: { typescript: '^5.0.0' },
        },
        null,
        2,
      ),
    );
    // Unparseable package.json -> parse returns null, file is skipped.
    writeFixture(cwd, 'packages/bad/package.json', '{ broken');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('reports no inconsistencies when every package matches root', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('dependency-version-consistency').run(cwd, {
        targetFiles: [join(cwd, 'package.json'), join(cwd, 'packages/a/package.json')],
      });
      const types = result.signals.map((s) => s.metadata.type);
      expect(types).not.toContain('version-mismatch');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('handles packages with no name and unparseable package.json without throwing', async () => {
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = await findCheck('dependency-version-consistency').run(cwd, {
        targetFiles: [
          join(cwd, 'package.json'),
          join(cwd, 'packages/noname/package.json'),
          join(cwd, 'packages/bad/package.json'),
        ],
      });
      expect(result.errors).toBe(0);
    } finally {
      process.chdir(origCwd);
    }
  });
});

// =============================================================================
// no-duplicate-packages: keyword match, excluded path, name-part dedup
// =============================================================================

describe('no-duplicate-packages keyword/exclusion branches', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('dup-pkg');
    // Two packages whose NAMES do not match a pattern but whose KEYWORDS do
    // (logging category) -> exercises the keyword-matching branch.
    writeFixture(
      cwd,
      'packages/alpha/package.json',
      JSON.stringify({
        name: '@org/alpha',
        keywords: ['logger'],
      }),
    );
    writeFixture(
      cwd,
      'packages/beta/package.json',
      JSON.stringify({
        name: '@org/beta',
        keywords: ['logging'],
      }),
    );
    // An excluded package (under __fixtures__) -> getPackageInfo returns null.
    writeFixture(
      cwd,
      'packages/__fixtures__/logger/package.json',
      JSON.stringify({
        name: '@org/fixture-logger',
        keywords: ['logger'],
      }),
    );
    // Scoped + unscoped variants of the same name part -> dedup collapses them.
    writeFixture(
      cwd,
      'packages/contracts/package.json',
      JSON.stringify({
        name: '@org/contracts',
      }),
    );
    writeFixture(
      cwd,
      'packages/dup-contracts/package.json',
      JSON.stringify({
        name: 'contracts',
      }),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('detects duplicates via keywords and skips excluded fixture packages', async () => {
    const result = await findCheck('no-duplicate-packages').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/alpha/package.json'),
        join(cwd, 'packages/beta/package.json'),
        join(cwd, 'packages/__fixtures__/logger/package.json'),
      ],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('logging'))).toBe(true);
    // The excluded fixture package must not appear in the duplicate list.
    expect(messages.some((m) => m.includes('fixture-logger'))).toBe(false);
  });

  it('collapses scoped and unscoped packages sharing a name part', async () => {
    const result = await findCheck('no-duplicate-packages').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/contracts/package.json'),
        join(cwd, 'packages/dup-contracts/package.json'),
      ],
    });
    // Both reduce to name part "contracts" -> only one entry -> below the
    // 2-package warning threshold -> no duplicate-contracts violation.
    const messages = result.signals.map((s) => s.message);
    expect(
      messages.some((m) => m.includes('contracts/types') || m.includes('Duplicate contracts')),
    ).toBe(false);
  });
});
