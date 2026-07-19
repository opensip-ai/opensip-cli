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

import {
  coreDescriptionAt,
  filterSameCorePackages,
  foreignCorePath,
  selfCore,
  selfCoreVersionString,
  selfScopeAbiVersion,
} from '../single-core-guard.js';

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
  // A pre-shared-ALS core (below the scope-ABI floor, no manifest field): genuinely
  // foreign, exercises the exact-version fallback path.
  plantCore(dir, { version: '0.0.0-foreign' });
}

/** Plant a `@opensip-cli/core` under `<dir>/node_modules` with a chosen version + optional scope ABI. */
function plantCore(dir: string, opts: { version: string; scopeAbi?: number }): void {
  const coreDir = join(dir, 'node_modules', '@opensip-cli', 'core');
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli/core',
      version: opts.version,
      main: 'index.js',
      ...(opts.scopeAbi === undefined ? {} : { opensipScopeAbiVersion: opts.scopeAbi }),
    }),
  );
  writeFileSync(join(coreDir, 'index.js'), 'module.exports = {};');
}

function packageInstallDir(root: string, packageName: string): string {
  const [scope, name] = packageName.split('/');
  if (scope === undefined || name === undefined) {
    throw new Error(`expected scoped package name, got ${packageName}`);
  }
  return join(root, 'node_modules', scope, name);
}

function writePackManifest(
  dir: string,
  deps: Record<string, string>,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-pack',
      version: '0.0.0',
      main: 'index.js',
      dependencies: deps,
      ...extra,
    }),
  );
}

function plantScopedRuntimePackage(root: string, packageName: string): string {
  const packageDir = packageInstallDir(root, packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '0.0.0-foreign',
      main: 'index.js',
      dependencies: { '@opensip-cli/core': 'workspace:*' },
    }),
  );
  writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};');
  return packageDir;
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

  it('describes the running scope ABI and core version for diagnostics', () => {
    expect(selfScopeAbiVersion()).toBe(1);
    expect(selfCoreVersionString()).toMatch(/^\d+\.\d+\.\d+/u);
    expect(coreDescriptionAt(selfCore() ?? '')).toMatchObject({
      path: selfCore(),
      version: selfCoreVersionString(),
      scopeAbi: selfScopeAbiVersion(),
    });
  });

  it('returns an empty description for entries without a valid owning core manifest', () => {
    const packageDir = join(testDir, 'not-core');
    const entryDir = join(packageDir, 'dist');
    const entry = join(entryDir, 'index.js');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'not-core' }));
    writeFileSync(entry, 'module.exports = {};');

    expect(coreDescriptionAt(entry)).toEqual({
      path: entry,
      version: undefined,
      scopeAbi: undefined,
    });

    writeFileSync(join(packageDir, 'package.json'), '{ malformed json');
    expect(coreDescriptionAt(entry)).toEqual({
      path: entry,
      version: undefined,
      scopeAbi: undefined,
    });
    expect(coreDescriptionAt('/opensip-core-entry-does-not-exist.js')).toEqual({
      path: '/opensip-core-entry-does-not-exist.js',
      version: undefined,
      scopeAbi: undefined,
    });
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
    writePackManifest(testDir, { '@opensip-cli/fitness': 'workspace:*' });
    const fitnessDir = plantScopedRuntimePackage(testDir, '@opensip-cli/fitness');
    plantForeignCore(fitnessDir);
    const foreign = foreignCorePath(testDir);
    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).not.toBe(selfCore());
  });

  it('returns the foreign core path when a simulation pack walks through simulation', () => {
    writePackManifest(testDir, { '@opensip-cli/simulation': 'workspace:*' });
    const simulationDir = plantScopedRuntimePackage(testDir, '@opensip-cli/simulation');
    plantForeignCore(simulationDir);

    const foreign = foreignCorePath(testDir);

    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).not.toBe(selfCore());
  });

  it('returns the foreign core path when a graph adapter walks through graph', () => {
    writePackManifest(testDir, { '@opensip-cli/graph': 'workspace:*' });
    const graphDir = plantScopedRuntimePackage(testDir, '@opensip-cli/graph');
    plantForeignCore(graphDir);

    const foreign = foreignCorePath(testDir);

    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).not.toBe(selfCore());
  });

  it('falls back to the direct-core probe when a pack declares no scoped runtime deps', () => {
    writePackManifest(testDir, { leftpad: '0.0.0' });
    plantForeignCore(testDir);

    const foreign = foreignCorePath(testDir);

    expect(foreign).toBeDefined();
    expect(foreign).toContain('@opensip-cli');
    expect(foreign).not.toBe(selfCore());
  });

  it('does not execute a discovered pack entry module while probing scoped deps', () => {
    const marker = '__opensipSingleCoreGuardEntryExecuted';
    delete (globalThis as Record<string, unknown>)[marker];
    writePackManifest(testDir, { '@opensip-cli/simulation': 'workspace:*' });
    writeFileSync(
      join(testDir, 'index.js'),
      `globalThis.${marker} = true; throw new Error('entry executed');`,
    );
    const simulationDir = plantScopedRuntimePackage(testDir, '@opensip-cli/simulation');
    plantForeignCore(simulationDir);

    expect(foreignCorePath(testDir)).toBeDefined();
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('falls back to direct-probe-only when the pack package.json is malformed', () => {
    writeFileSync(join(testDir, 'package.json'), '{not json', 'utf8');
    const simulationDir = plantScopedRuntimePackage(testDir, '@opensip-cli/simulation');
    plantForeignCore(simulationDir);

    expect(() => foreignCorePath(testDir)).not.toThrow();
    expect(foreignCorePath(testDir)).toBeUndefined();
  });

  it('skips declared scoped runtime dependencies that are not installed', () => {
    writePackManifest(testDir, { '@opensip-cli/not-installed': 'workspace:*' });

    expect(foreignCorePath(testDir)).toBeUndefined();
  });

  it('skips a resolved scoped runtime dependency that has no resolvable core', () => {
    writePackManifest(testDir, { '@opensip-cli/runtime-without-core': 'workspace:*' });
    const packageDir = packageInstallDir(testDir, '@opensip-cli/runtime-without-core');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@opensip-cli/runtime-without-core',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};');

    expect(foreignCorePath(testDir)).toBeUndefined();
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

describe('scope ABI identity (ADR-0103)', () => {
  it('KEEPS a different-version core that explicitly declares the same scope ABI', () => {
    // Version is wildly different, but the scope ABI matches this runtime's (1),
    // so the two share the globalThis-pinned scope ALS and interoperate.
    plantCore(testDir, { version: '9.9.9', scopeAbi: 1 });
    const kept = filterSameCorePackages([{ name: 'same-abi', packageDir: testDir }]);
    expect(kept.map((p) => p.name)).toEqual(['same-abi']);
    expect(foreignCorePath(testDir)).toBeUndefined();
  });

  it('KEEPS a core with no ABI field whose version is at/above the shared-ALS floor', () => {
    // The 0.1.15-vs-0.1.18 case: an older published core (no manifest field) is
    // inferred as scope ABI 1 from its version, so a global newer CLI loads it.
    plantCore(testDir, { version: '0.1.15' });
    const kept = filterSameCorePackages([{ name: 'inferred-abi', packageDir: testDir }]);
    expect(kept.map((p) => p.name)).toEqual(['inferred-abi']);
    expect(foreignCorePath(testDir)).toBeUndefined();
  });

  it('DROPS a core that explicitly declares a different scope ABI', () => {
    plantCore(testDir, { version: '9.9.9', scopeAbi: 999 });
    const dropped: string[] = [];
    const kept = filterSameCorePackages([{ name: 'future-abi', packageDir: testDir }], (pkg) =>
      dropped.push(pkg.name),
    );
    expect(kept).toEqual([]);
    expect(dropped).toEqual(['future-abi']);
    expect(foreignCorePath(testDir)).toBeDefined();
  });

  it('DROPS a pre-floor core with no ABI field (exact-version fallback)', () => {
    plantCore(testDir, { version: '0.1.10' });
    const kept = filterSameCorePackages([{ name: 'pre-pin', packageDir: testDir }]);
    expect(kept).toEqual([]);
  });
});
