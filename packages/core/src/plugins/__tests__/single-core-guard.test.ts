/**
 * single-core-guard — the discovery-time policy that drops capability packs which
 * resolve a DIFFERENT physical `@opensip-cli/core` than the running engine.
 *
 * `selfCore()` is the canonical core this runtime resolves; `foreignCorePath`
 * probes a pack's resolved core; `filterSameCorePackages` keeps only same-core
 * (or core-less) packs and reports each foreign drop via `onForeign`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filterSameCorePackages, foreignCorePath, selfCore } from '../single-core-guard.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-single-core-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Plant a self-contained `@opensip-cli/core` under `<dir>/node_modules` so a
 * pack rooted at `dir` resolves THAT physical copy — a "foreign" core distinct
 * from the test runner's own resolved core.
 */
function plantForeignCore(dir: string): void {
  const coreDir = join(dir, 'node_modules', '@opensip-cli', 'core');
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({ name: '@opensip-cli/core', version: '0.0.0-foreign', main: 'index.js' }),
  );
  writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');
}

describe('selfCore', () => {
  it('resolves a concrete path to the running @opensip-cli/core', () => {
    const self = selfCore();
    expect(self).toBeDefined();
    // Resolves to core's own entry point (a workspace `packages/core/...` path
    // in this monorepo, or a `node_modules/@opensip-cli/core/...` path when
    // installed) — in either case a concrete, absolute file path.
    expect(self).toMatch(/[/\\]core[/\\]/);
  });
});

describe('foreignCorePath', () => {
  it('returns undefined for a pack dir with no resolvable core (no core dep)', () => {
    // testDir has no node_modules at all → resolution throws → "no foreign core".
    expect(foreignCorePath(testDir)).toBeUndefined();
  });

  it('returns the foreign core path for a pack that vendors its own core', () => {
    plantForeignCore(testDir);
    const foreign = foreignCorePath(testDir);
    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).toContain(testDir);
    expect(foreign).not.toBe(selfCore());
  });

  it('returns the foreign core path when fitness transitively resolves a different core', () => {
    const fitnessDir = join(testDir, 'node_modules', '@opensip-cli', 'fitness');
    mkdirSync(fitnessDir, { recursive: true });
    writeFileSync(
      join(fitnessDir, 'package.json'),
      JSON.stringify({
        name: '@opensip-cli/fitness',
        version: '0.0.0-foreign',
        main: 'index.js',
        dependencies: { '@opensip-cli/core': 'workspace:*' },
      }),
    );
    writeFileSync(join(fitnessDir, 'index.js'), 'module.exports = {};');
    plantForeignCore(fitnessDir);
    const foreign = foreignCorePath(testDir);
    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).not.toBe(selfCore());
  });
});

describe('filterSameCorePackages', () => {
  it('keeps packs with no core dependency', () => {
    const pkgs = [{ name: 'no-core', packageDir: testDir }];
    expect(filterSameCorePackages(pkgs)).toEqual(pkgs);
  });

  it('drops a foreign-core pack and reports it via onForeign', () => {
    plantForeignCore(testDir);
    const pkgs = [{ name: 'foreign-pack', packageDir: testDir }];
    const dropped: { name: string; foreignCore: string }[] = [];

    const kept = filterSameCorePackages(pkgs, (pkg, foreignCore) => {
      dropped.push({ name: pkg.name, foreignCore });
    });

    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].name).toBe('foreign-pack');
    expect(dropped[0].foreignCore).toContain('@opensip-cli');
  });

  it('keeps same-core packs and drops only the foreign one in a mixed set', () => {
    const sameCoreDir = mkdtempSync(join(tmpdir(), 'opensip-same-core-'));
    plantForeignCore(testDir);
    try {
      const pkgs = [
        { name: 'same-core', packageDir: sameCoreDir },
        { name: 'foreign', packageDir: testDir },
      ];
      const kept = filterSameCorePackages(pkgs);
      expect(kept.map((p) => p.name)).toEqual(['same-core']);
    } finally {
      rmSync(sameCoreDir, { recursive: true, force: true });
    }
  });
});
