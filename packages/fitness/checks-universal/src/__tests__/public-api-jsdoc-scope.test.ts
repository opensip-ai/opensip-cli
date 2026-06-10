/**
 * @fileoverview Public-API scoping tests for `public-api-jsdoc`.
 *
 * Verifies the check's tuned behavior: only files reachable from the
 * containing package's `package.json#exports` entries via
 * `export ... from` re-export chains are flagged. Internal helper
 * files whose `export` is intra-package-only are skipped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { _resetPublicApiGraphCache } from '../checks/documentation/_public-api-graph.js';
import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-pubapi-${prefix}-`));
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

describe('public-api-jsdoc — package.json exports scoping', () => {
  let cwd: string;
  let publicFile: string;
  let internalFile: string;
  let untrackedFile: string;

  beforeAll(() => {
    cwd = makeFixtureDir('exports');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify({
        name: 'fixture-pkg',
        type: 'module',
        exports: { '.': './dist/index.js' },
      }),
    );
    // Re-exported from index → in the public surface.
    writeFixture(
      cwd,
      'src/index.ts',
      [
        "export * from './public.js'",
        // `internal-helper` is imported but NOT re-exported below — so its
        // exports are NOT part of the public surface.
        "import { helper } from './internal-helper.js'",
        'export const useHelper = () => helper()',
      ].join('\n'),
    );
    publicFile = writeFixture(
      cwd,
      'src/public.ts',
      ['export function publicNoJsdoc() { return 1 }'].join('\n'),
    );
    internalFile = writeFixture(
      cwd,
      'src/internal-helper.ts',
      ['export function helper() { return 2 }'].join('\n'),
    );
    // A completely unrelated file in src/ — not reachable from index.
    untrackedFile = writeFixture(
      cwd,
      'src/orphan.ts',
      ['export function orphan() { return 3 }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags exports in files reachable via re-exports', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [publicFile],
    });
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals[0]?.message).toContain('publicNoJsdoc');
  });

  it('skips internal helper files imported (but not re-exported) from the barrel', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [internalFile],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips orphan files not reachable from any export entry', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [untrackedFile],
    });
    expect(result.signals.length).toBe(0);
  });
});

describe('public-api-jsdoc — fallback behavior', () => {
  let cwd: string;
  let file: string;

  beforeAll(() => {
    cwd = makeFixtureDir('fallback');
    // No package.json → cannot resolve surface → check falls back to
    // flagging every export (historical broad behavior).
    file = writeFixture(cwd, 'src/leaf.ts', ['export function leaf() { return 1 }'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('falls back to broad behavior when no package.json is found', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [file],
    });
    // The walk hits the tmpdir without ever finding a package.json,
    // so the check open-fails and flags `leaf`.
    expect(result.signals.length).toBeGreaterThan(0);
  });
});

describe('public-api-jsdoc — exports map shapes', () => {
  let cwd: string;
  let publicFile: string;

  beforeAll(() => {
    cwd = makeFixtureDir('conditional-exports');
    // Conditional + multi-subpath exports — the graph walk should
    // descend through the object structure and collect each leaf string.
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify({
        name: 'fixture-pkg',
        type: 'module',
        exports: {
          '.': {
            import: './dist/index.js',
            require: './dist/index.cjs',
          },
          './sub': './dist/sub.js',
          './bad-wildcard/*': './dist/parts/*.js',
        },
      }),
    );
    writeFixture(cwd, 'src/index.ts', ["export * from './a.js'"].join('\n'));
    publicFile = writeFixture(
      cwd,
      'src/a.ts',
      ['export function aNoJsdoc() { return 1 }'].join('\n'),
    );
    writeFixture(cwd, 'src/sub.ts', ['export function subSymbol() { return 2 }'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('descends through conditional + subpath exports', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [publicFile],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('skips wildcard subpath patterns without crashing', async () => {
    // Just verify that the wildcard entry doesn't break the run; the
    // `src/a.ts` reachability comes from the `.` entry.
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [publicFile],
    });
    expect(result).toBeDefined();
  });
});

describe('public-api-jsdoc — binary-only package has empty surface', () => {
  let cwd: string;
  let file: string;

  beforeAll(() => {
    cwd = makeFixtureDir('bin-only');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify({
        name: 'bin-only-pkg',
        type: 'module',
        bin: { 'my-cli': './dist/index.js' },
      }),
    );
    file = writeFixture(
      cwd,
      'src/leaf.ts',
      ['export function leafSymbol() { return 1 }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('treats every source file as internal when only `bin` is declared', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [file],
    });
    expect(result.signals.length).toBe(0);
  });
});

describe('public-api-jsdoc — fallback when no exports field', () => {
  let cwd: string;
  let file: string;

  beforeAll(() => {
    cwd = makeFixtureDir('main-only');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify({ name: 'main-only-pkg', main: './dist/index.js' }),
    );
    writeFixture(cwd, 'src/index.ts', ["export * from './public.js'"].join('\n'));
    file = writeFixture(
      cwd,
      'src/public.ts',
      ['export function publicMainOnly() { return 1 }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('honors `main` field when `exports` is absent', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [file],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });
});
