import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverTypescriptWorkspaceUnits } from '../workspace-units.js';

describe('discoverTypescriptWorkspaceUnits', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'osip-ts-ws-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns [] when packages/ does not exist', async () => {
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toEqual([]);
  });

  it('returns [] when packages/ is empty', async () => {
    mkdirSync(join(root, 'packages'));
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toEqual([]);
  });

  it('returns one unit for packages/foo/tsconfig.json', async () => {
    mkdirSync(join(root, 'packages', 'foo'), { recursive: true });
    writeFileSync(join(root, 'packages', 'foo', 'tsconfig.json'), '{}');
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe('foo');
    expect(units[0]?.rootDir).toBe(join(root, 'packages', 'foo'));
    expect(units[0]?.configPath).toBe(join(root, 'packages', 'foo', 'tsconfig.json'));
  });

  it('does NOT recurse past the outer tsconfig.json', async () => {
    mkdirSync(join(root, 'packages', 'foo', 'sub'), { recursive: true });
    writeFileSync(join(root, 'packages', 'foo', 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'packages', 'foo', 'sub', 'tsconfig.json'), '{}');
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toHaveLength(1);
    expect(units[0]?.rootDir).toBe(join(root, 'packages', 'foo'));
  });

  it('skips node_modules / dist / build', async () => {
    mkdirSync(join(root, 'packages', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'packages', 'node_modules', 'pkg', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'packages', 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', 'dist', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'packages', 'build'), { recursive: true });
    writeFileSync(join(root, 'packages', 'build', 'tsconfig.json'), '{}');
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toEqual([]);
  });

  it('returns multiple units sorted by rootDir', async () => {
    mkdirSync(join(root, 'packages', 'b'), { recursive: true });
    writeFileSync(join(root, 'packages', 'b', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writeFileSync(join(root, 'packages', 'a', 'tsconfig.json'), '{}');
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toHaveLength(2);
    expect(units[0]?.id).toBe('a');
    expect(units[1]?.id).toBe('b');
  });

  it('gives nested packages a root-relative POSIX id', async () => {
    mkdirSync(join(root, 'packages', 'fitness', 'engine'), { recursive: true });
    writeFileSync(join(root, 'packages', 'fitness', 'engine', 'tsconfig.json'), '{}');
    const units = await discoverTypescriptWorkspaceUnits(root);
    expect(units).toHaveLength(1);
    expect(units[0]?.id).toBe('fitness/engine');
  });

  it('gives same-basename packages DISTINCT ids (no shard-id collision)', async () => {
    // This monorepo has three packages all named `engine`. A bare basename id
    // would collapse them onto one shard id and silently overwrite the
    // fragment-cache PK rows. The root-relative id keeps them distinct.
    for (const dir of ['fitness/engine', 'graph/engine', 'simulation/engine']) {
      mkdirSync(join(root, 'packages', ...dir.split('/')), { recursive: true });
      writeFileSync(join(root, 'packages', ...dir.split('/'), 'tsconfig.json'), '{}');
    }
    const units = await discoverTypescriptWorkspaceUnits(root);
    const ids = units.map((u) => u.id);
    expect(ids).toEqual(['fitness/engine', 'graph/engine', 'simulation/engine']);
    // Crucially: all distinct.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds the repo workspace units when run against this repo', async () => {
    // resolve to repo root: src/__tests__/x.test.ts -> ../../../../..
    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(here, '..', '..', '..', '..', '..', '..');
    const units = await discoverTypescriptWorkspaceUnits(repoRoot);
    expect(units.length).toBeGreaterThanOrEqual(20);
    for (const u of units) {
      expect(u.rootDir.startsWith(repoRoot)).toBe(true);
      expect(u.configPath?.endsWith('tsconfig.json')).toBe(true);
    }
  });
});
