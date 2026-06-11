// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Branch-behavior tests for medium-coverage checks (round 11).
 *
 * Targets the fitness/TypeScript directive parsers (direct unit tests)
 * and the public-api-jsdoc analyzer's export-kind / lookback branches.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseFitnessDirectives } from '../checks/documentation/_directives/fitness.js';
import { parseTypeScriptDirectives } from '../checks/documentation/_directives/typescript.js';
import { _resetPublicApiGraphCache } from '../checks/documentation/_public-api-graph.js';
import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov11-${prefix}-`));
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
// parseFitnessDirectives: check-id + reason grammar branches
// =============================================================================

describe('parseFitnessDirectives', () => {
  it('parses a file-scope directive with id and reason', () => {
    const [d] = parseFitnessDirectives(
      '// @fitness-ignore-file my-check -- justified for X',
      'a.ts',
      'a.ts',
    );
    expect(d?.rule).toBe('fitness/my-check');
    expect(d?.scope).toBe('file');
    expect(d?.reason).toBe('justified for X');
  });

  it('parses a next-line directive', () => {
    const [d] = parseFitnessDirectives(
      'const x = 1 // @fitness-ignore-next-line some-check -- inline reason',
      'a.ts',
      'a.ts',
    );
    expect(d?.scope).toBe('next-line');
    expect(d?.rule).toBe('fitness/some-check');
  });

  it('returns nothing for lines without a fitness marker', () => {
    expect(parseFitnessDirectives('const x = 1', 'a.ts', 'a.ts')).toEqual([]);
  });

  it('returns nothing when there is no space after the marker', () => {
    // `@fitness-ignore-file` immediately at end of line — no id token.
    expect(parseFitnessDirectives('// @fitness-ignore-file', 'a.ts', 'a.ts')).toEqual([]);
  });

  it('returns nothing when the -- reason separator is absent', () => {
    expect(parseFitnessDirectives('// @fitness-ignore-file my-check', 'a.ts', 'a.ts')).toEqual([]);
  });
});

// =============================================================================
// parseTypeScriptDirectives: comment-context branch
// =============================================================================

describe('parseTypeScriptDirectives', () => {
  it('parses a @ts-expect-error directive inside a // comment', () => {
    const [d] = parseTypeScriptDirectives(
      '// @ts-expect-error: upstream typings are wrong',
      'a.ts',
      'a.ts',
    );
    expect(d?.rule).toBe('@ts-expect-error');
    expect(d?.reason).toBe('upstream typings are wrong');
  });

  it('ignores a @ts-expect-error token that is not in a // comment', () => {
    // The token appears bare (e.g. inside a non-comment string of source),
    // with no `//` before it -> the comment-context guard rejects it.
    expect(parseTypeScriptDirectives('const s = @ts-expect-error', 'a.ts', 'a.ts')).toEqual([]);
  });

  it('returns nothing for lines without the directive', () => {
    expect(parseTypeScriptDirectives('const x = 1', 'a.ts', 'a.ts')).toEqual([]);
  });
});

// =============================================================================
// public-api-jsdoc: export-kind + JSDoc-lookback branches
// =============================================================================

describe('public-api-jsdoc lookback branches', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('jsdoc-lookback');
    // A package whose barrel re-exports the file under test, making it part
    // of the public API surface.
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify({
        name: '@org/api',
        exports: './dist/index.js',
      }),
    );
    writeFixture(cwd, 'src/index.ts', "export * from './surface.js'");
    writeFixture(
      cwd,
      'src/surface.ts',
      [
        '// a single-line comment, not JSDoc',
        '',
        'export type Undocumented = number',
        '',
        "export * from './other.js'",
        '',
        '/**',
        ' * Documented function.',
        ' */',
        '',
        'export function documented() { return 1 }',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags an undocumented type export but not a JSDoc-documented one or a re-export', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [join(cwd, 'src/surface.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    // The `type` export with only a `//` comment + blank line above is flagged.
    expect(messages.some((m) => m.includes("'Undocumented'") && m.includes('type'))).toBe(true);
    // The function preceded by a JSDoc block (with a blank line gap) is not.
    expect(messages.some((m) => m.includes("'documented'"))).toBe(false);
  });
});
