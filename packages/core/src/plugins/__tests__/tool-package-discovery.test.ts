import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPackagesInNodeModules } from '../marker-discovery.js';
import {
  discoverToolPackages,
  discoverToolPackagesFromAnchors,
  readToolPackageMetadata,
} from '../tool-package-discovery.js';

let testDir: string;

function writePkg(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-tool-discover-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('discoverToolPackages', () => {
  it('returns an empty list when node_modules is missing', () => {
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('finds an unscoped package marked as a tool', () => {
    writePkg(join(testDir, 'node_modules', 'audit'), {
      name: 'audit',
      opensipTools: { kind: 'tool' },
    });
    const out = discoverToolPackages({ projectDir: testDir });
    expect(out.map((t) => t.name)).toEqual(['audit']);
  });

  it('finds a scoped package marked as a tool', () => {
    writePkg(join(testDir, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });
    const out = discoverToolPackages({ projectDir: testDir });
    expect(out.map((t) => t.name)).toEqual(['@opensip-tools/fitness']);
  });

  it('skips packages that are not marked as tools', () => {
    writePkg(join(testDir, 'node_modules', 'random-pkg'), { name: 'random-pkg' });
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('skips dot-prefixed entries (.bin, .pnpm, etc.)', () => {
    writePkg(join(testDir, 'node_modules', '.bin', 'fake-tool'), {
      name: 'fake-tool',
      opensipTools: { kind: 'tool' },
    });
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });

  it('walks ancestor node_modules and dedupes by package name', () => {
    const nested = join(testDir, 'project');
    mkdirSync(nested, { recursive: true });

    writePkg(join(testDir, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });
    writePkg(join(nested, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });

    const out = discoverToolPackages({ projectDir: nested });
    expect(out).toHaveLength(1);
    // Nearest-ancestor wins: the inner copy
    expect(out[0]?.packageDir).toBe(join(nested, 'node_modules', '@opensip-tools', 'fitness'));
  });

  it('treats malformed package.json as non-tool (no crash)', () => {
    const dir = join(testDir, 'node_modules', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{not-json');
    expect(discoverToolPackages({ projectDir: testDir })).toEqual([]);
  });
});

describe('discoverPackagesInNodeModules (single-dir scan, no walk-up)', () => {
  it('finds a tool in the exact node_modules dir', () => {
    writePkg(join(testDir, 'host', 'node_modules', '@my', 'audit'), {
      name: '@my/audit',
      opensipTools: { kind: 'tool' },
    });
    const out = discoverPackagesInNodeModules(join(testDir, 'host', 'node_modules'), 'tool');
    expect(out.map((t) => t.name)).toEqual(['@my/audit']);
  });

  it('does NOT walk up into ancestor node_modules', () => {
    // A tool in an ANCESTOR node_modules must be invisible to the single-dir
    // scan (this is the property that keeps a host-dir scan from pulling in
    // $HOME/node_modules).
    writePkg(join(testDir, 'node_modules', 'ancestor-tool'), {
      name: 'ancestor-tool',
      opensipTools: { kind: 'tool' },
    });
    const emptyHost = join(testDir, 'host', 'node_modules');
    mkdirSync(emptyHost, { recursive: true });
    expect(discoverPackagesInNodeModules(emptyHost, 'tool')).toEqual([]);
  });

  it('returns [] when the dir does not exist', () => {
    expect(discoverPackagesInNodeModules(join(testDir, 'nope'), 'tool')).toEqual([]);
  });
});

describe('discoverToolPackagesFromAnchors', () => {
  it('merges walkUp + scanDir sources, first-occurrence-wins on duplicate name', () => {
    // Project-local host dir (scanDir) pins audit@local; the cwd walk also
    // sees a different copy — the earlier source wins.
    writePkg(join(testDir, 'proj', '.runtime', 'plugins', 'tool', 'node_modules', 'audit'), {
      name: 'audit',
      opensipTools: { kind: 'tool' },
    });
    writePkg(join(testDir, 'cwd', 'node_modules', 'audit'), {
      name: 'audit',
      opensipTools: { kind: 'tool' },
    });
    writePkg(join(testDir, 'cwd', 'node_modules', 'other'), {
      name: 'other',
      opensipTools: { kind: 'tool' },
    });

    const out = discoverToolPackagesFromAnchors([
      { dir: join(testDir, 'proj', '.runtime', 'plugins', 'tool'), mode: 'scanDir' },
      { dir: join(testDir, 'cwd'), mode: 'walkUp' },
    ]);
    expect(out.map((t) => t.name).sort()).toEqual(['audit', 'other']);
    // First source (project-local scanDir) wins for the duplicate name.
    expect(out.find((t) => t.name === 'audit')?.packageDir).toBe(
      join(testDir, 'proj', '.runtime', 'plugins', 'tool', 'node_modules', 'audit'),
    );
  });

  it('returns [] when no source yields a tool', () => {
    expect(
      discoverToolPackagesFromAnchors([{ dir: join(testDir, 'empty'), mode: 'walkUp' }]),
    ).toEqual([]);
  });
});

describe('readToolPackageMetadata', () => {
  let pkgDir: string;
  beforeEach(() => {
    pkgDir = join(testDir, 'pkg');
    mkdirSync(pkgDir, { recursive: true });
  });

  it('returns undefined when neither package.json nor an authored sidecar is present', () => {
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('returns undefined when package.json is malformed', () => {
    writeFileSync(join(pkgDir, 'package.json'), '{');
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('returns undefined when name is missing', () => {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({}));
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('falls back to ./index.js when no exports or main are declared', () => {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg' }));
    expect(readToolPackageMetadata(pkgDir)).toEqual({
      name: 'pkg',
      mainEntry: join(pkgDir, './index.js'),
    });
  });

  it('uses pkg.main when declared', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', main: './lib/main.js' }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './lib/main.js'));
  });

  it('uses string-form exports when declared', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', exports: './dist/index.js' }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/index.js'));
  });

  it('uses object-form exports["."]', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', exports: { '.': './dist/dot.js' } }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/dot.js'));
  });

  it('uses exports["."]["import"] when present', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        exports: { '.': { import: './dist/import.js', default: './dist/default.js' } },
      }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/import.js'));
  });

  it('falls back to exports["."]["default"] when import is absent', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'pkg',
        exports: { '.': { default: './dist/default.js' } },
      }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/default.js'));
  });

  // Authored tools have NO package.json — entry resolves from the sidecar.
  it("resolves an authored sidecar's `main` when there is no package.json", () => {
    writeFileSync(
      join(pkgDir, 'opensip-tool.manifest.json'),
      JSON.stringify({
        kind: 'tool',
        id: 'audit',
        name: '@my-co/audit',
        version: '1.0.0',
        main: './dist/audit.js',
        commands: [],
      }),
    );
    expect(readToolPackageMetadata(pkgDir)).toEqual({
      name: '@my-co/audit',
      mainEntry: join(pkgDir, './dist/audit.js'),
    });
  });

  it('defaults an authored sidecar entry to ./index.js when `main` is absent, naming from id', () => {
    writeFileSync(
      join(pkgDir, 'opensip-tool.manifest.json'),
      JSON.stringify({ kind: 'tool', id: 'bench', version: '1.0.0', commands: [] }),
    );
    expect(readToolPackageMetadata(pkgDir)).toEqual({
      name: 'bench',
      mainEntry: join(pkgDir, './index.js'),
    });
  });

  it('prefers a real package.json over an authored sidecar when both exist', () => {
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'pkg', main: './dist/pkg.js' }),
    );
    writeFileSync(
      join(pkgDir, 'opensip-tool.manifest.json'),
      JSON.stringify({ kind: 'tool', id: 'audit', main: './dist/sidecar.js', commands: [] }),
    );
    expect(readToolPackageMetadata(pkgDir)?.mainEntry).toBe(join(pkgDir, './dist/pkg.js'));
  });

  it('returns undefined for a malformed authored sidecar (no resolvable entry)', () => {
    writeFileSync(join(pkgDir, 'opensip-tool.manifest.json'), '{not-json');
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('returns undefined when the authored sidecar parses to a non-object (e.g. a JSON array)', () => {
    writeFileSync(
      join(pkgDir, 'opensip-tool.manifest.json'),
      JSON.stringify(['not', 'an', 'object']),
    );
    expect(readToolPackageMetadata(pkgDir)).toBeUndefined();
  });

  it('falls back to the directory name when the sidecar has neither name nor id', () => {
    writeFileSync(
      join(pkgDir, 'opensip-tool.manifest.json'),
      JSON.stringify({ kind: 'tool', main: './dist/x.js', commands: [] }),
    );
    expect(readToolPackageMetadata(pkgDir)?.name).toBe('pkg');
  });
});
