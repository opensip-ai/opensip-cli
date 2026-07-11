/**
 * Tests for the shared public-export-surface walker (ADR-0151).
 *
 * Uses tiny throwaway fixture files under a mkdtemp repo root. Resource caps
 * are exercised via the injectable `limits` option so no giant fixtures are
 * needed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  comparePublicExportSurface,
  readPublicExportSurface,
} from '../lib/public-export-surface.mjs';

/**
 * Create an isolated repo with the given files, run `fn(root)`, and clean up.
 * @param {Record<string, string>} files map of repo-relative path → contents
 * @param {(root: string) => void} fn
 */
function withRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'pes-'));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('classifies every declaration kind, inline type, alias, wildcard, and external re-export', () => {
  withRepo(
    {
      'inner.ts': [
        'export const inner = 1;',
        'export interface InnerType { y: number }',
        'export type TypeOnly = number;',
      ].join('\n'),
      'star.ts': ['export const starVal = 1;', 'export class StarClass {}'].join('\n'),
      'entry.ts': [
        'export const namedValue = 1;', // named value export
        'export function fn() {}', // value
        'export class Dual {}', // dual → value + type
        'export enum DualEnum { A }', // dual → value + type
        'export interface OnlyIface { x: number }', // type
        'export type OnlyAlias = string;', // type
        'export { namedValue as aliasedValue };', // alias (local re-export)
        "export { inner, type InnerType } from './inner.js';", // value + inline type
        "export type { TypeOnly } from './inner.js';", // export type
        "export * from './star.js';", // contained wildcard recursion
        "export { extThing } from 'external-pkg';", // external named re-export (value, not followed)
        "export type { ExtType } from 'external-pkg';", // external named re-export (type, not followed)
      ].join('\n'),
    },
    (root) => {
      const s = readPublicExportSurface('entry.ts', { repoRoot: root });

      // value space
      for (const v of [
        'namedValue',
        'fn',
        'Dual',
        'DualEnum',
        'aliasedValue',
        'inner',
        'starVal',
        'StarClass',
        'extThing',
      ]) {
        assert.ok(s.valueExports.includes(v), `expected value export ${v}`);
      }

      // type space
      for (const t of [
        'Dual',
        'DualEnum',
        'OnlyIface',
        'OnlyAlias',
        'InnerType',
        'TypeOnly',
        'StarClass',
        'ExtType',
      ]) {
        assert.ok(s.typeExports.includes(t), `expected type export ${t}`);
      }

      // dual-space classes/enums appear in BOTH namespaces
      assert.ok(s.valueExports.includes('Dual') && s.typeExports.includes('Dual'));
      assert.ok(s.valueExports.includes('DualEnum') && s.typeExports.includes('DualEnum'));
      assert.ok(s.valueExports.includes('StarClass') && s.typeExports.includes('StarClass'));

      // type-only things never leak into value space
      for (const t of ['OnlyIface', 'OnlyAlias', 'InnerType', 'TypeOnly', 'ExtType']) {
        assert.ok(!s.valueExports.includes(t), `${t} must not be a value export`);
      }

      // wildcard specifier recorded
      assert.deepEqual(s.wildcards, ['./star.js']);
    },
  );
});

test('regression: a type-only re-export lands in typeExports (a runtime Object.keys would miss it)', () => {
  withRepo(
    {
      't.ts': 'export interface OnlyType { a: number }\nexport const runtimeValue = 1;',
      // A runtime `Object.keys(await import('./entry.js'))` would only see
      // `runtimeValue`; the static walker must still surface OnlyType as a type.
      'entry.ts': "export type { OnlyType } from './t.js';\nexport { runtimeValue } from './t.js';",
    },
    (root) => {
      const s = readPublicExportSurface('entry.ts', { repoRoot: root });
      assert.ok(s.typeExports.includes('OnlyType'), 'OnlyType must be a type export');
      assert.ok(!s.valueExports.includes('OnlyType'), 'OnlyType must not be a value export');
      assert.deepEqual(s.valueExports, ['runtimeValue']);
    },
  );
});

test('a plain re-export resolves the target declaration kind (dual class → both)', () => {
  withRepo(
    {
      'impl.ts': 'export class Widget {}\nexport const helper = () => 1;',
      'entry.ts': "export { Widget, helper } from './impl.js';",
    },
    (root) => {
      const s = readPublicExportSurface('entry.ts', { repoRoot: root });
      assert.ok(s.valueExports.includes('Widget') && s.typeExports.includes('Widget'));
      assert.ok(s.valueExports.includes('helper') && !s.typeExports.includes('helper'));
    },
  );
});

test('a contained export * cycle terminates without infinite recursion', () => {
  withRepo(
    {
      'b.ts': "export const fromB = 1;\nexport * from './entry.js';",
      'entry.ts': "export * from './b.js';",
    },
    (root) => {
      const s = readPublicExportSurface('entry.ts', { repoRoot: root });
      assert.ok(s.valueExports.includes('fromB'));
      // wildcard spine records both stars and still terminates
      assert.deepEqual([...s.wildcards].sort(), ['./b.js', './entry.js']);
    },
  );
});

test('external named re-export is classified from syntax and not followed to disk', () => {
  withRepo(
    {
      // no on-disk file for 'totally-missing-pkg' — must NOT be resolved
      'entry.ts': [
        "export { a } from 'totally-missing-pkg';",
        "export type { B } from 'totally-missing-pkg';",
      ].join('\n'),
    },
    (root) => {
      const s = readPublicExportSurface('entry.ts', { repoRoot: root });
      assert.deepEqual(s.valueExports, ['a']);
      assert.deepEqual(s.typeExports, ['B']);
      assert.deepEqual(s.wildcards, []);
    },
  );
});

test('a missing relative re-export target throws', () => {
  withRepo({ 'entry.ts': "export { x } from './does-not-exist.js';" }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root }),
      /missing relative re-export target/,
    );
  });
});

test('a relative target escaping the repo root throws (path escape)', () => {
  const outer = mkdtempSync(join(tmpdir(), 'pes-outer-'));
  try {
    writeFileSync(join(outer, 'secret.ts'), 'export const secret = 1;');
    const repo = join(outer, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'entry.ts'), "export * from '../secret.js';");
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: repo }),
      /outside repo root/,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('a symlink escaping the repo root throws (symlink escape)', () => {
  const outer = mkdtempSync(join(tmpdir(), 'pes-sym-'));
  try {
    writeFileSync(join(outer, 'secret.ts'), 'export const secret = 1;');
    const repo = join(outer, 'repo');
    mkdirSync(repo, { recursive: true });
    // in-repo symlink pointing outside the repo root
    symlinkSync(join(outer, 'secret.ts'), join(repo, 'link.ts'));
    writeFileSync(join(repo, 'entry.ts'), "export * from './link.js';");
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: repo }),
      /outside repo root/,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('cap: source-file size', () => {
  withRepo({ 'entry.ts': `// ${'x'.repeat(500)}\nexport const a = 1;` }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root, limits: { maxSourceBytes: 50 } }),
      /exceeds 50-byte cap/,
    );
  });
});

test('cap: files traversed', () => {
  withRepo(
    {
      'a.ts': 'export const x = 1;',
      'entry.ts': "export { x } from './a.js';",
    },
    (root) => {
      assert.throws(
        () => readPublicExportSurface('entry.ts', { repoRoot: root, limits: { maxFiles: 1 } }),
        /traversed more than 1 files/,
      );
    },
  );
});

test('cap: re-export depth', () => {
  withRepo(
    {
      'a.ts': 'export const x = 1;',
      'entry.ts': "export { x } from './a.js';",
    },
    (root) => {
      assert.throws(
        () => readPublicExportSurface('entry.ts', { repoRoot: root, limits: { maxDepth: 0 } }),
        /re-export depth exceeded 0/,
      );
    },
  );
});

test('cap: names per surface', () => {
  withRepo({ 'entry.ts': 'export const a = 1;\nexport const b = 2;' }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root, limits: { maxNames: 1 } }),
      /exceeds 1 names/,
    );
  });
});

test('cap: resolved path length', () => {
  withRepo({ 'entry.ts': 'export const a = 1;' }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root, limits: { maxPathBytes: 5 } }),
      /path exceeds 5-byte cap/,
    );
  });
});

test('unsupported export = / export default declarations throw', () => {
  withRepo({ 'entry.ts': 'const x = 1;\nexport = x;' }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root }),
      /unsupported export/,
    );
  });
  withRepo({ 'entry.ts': 'export default function foo() {}' }, (root) => {
    assert.throws(
      () => readPublicExportSurface('entry.ts', { repoRoot: root }),
      /unsupported export default/,
    );
  });
});

test('conflicting aliases resolved to different kinds throw', () => {
  withRepo(
    {
      'a.ts': 'export const Foo = 1;',
      'b.ts': 'export interface Foo { z: number }',
      // same exported name Foo, value via a.js and type via b.js
      'entry.ts': "export { Foo } from './a.js';\nexport type { Foo } from './b.js';",
    },
    (root) => {
      assert.throws(
        () => readPublicExportSurface('entry.ts', { repoRoot: root }),
        /conflicting export 'Foo'/,
      );
    },
  );
});

test('comparePublicExportSurface reports missing and stale per namespace', () => {
  const actual = { valueExports: ['a', 'b'], typeExports: ['T', 'U'] };
  const expected = { valueExports: ['a', 'c'], typeExports: ['T', 'V'] };
  const diff = comparePublicExportSurface(actual, expected);
  assert.deepEqual(diff.missingValues, ['b']); // live, not allowlisted
  assert.deepEqual(diff.staleValues, ['c']); // allowlisted, not live
  assert.deepEqual(diff.missingTypes, ['U']);
  assert.deepEqual(diff.staleTypes, ['V']);
});
