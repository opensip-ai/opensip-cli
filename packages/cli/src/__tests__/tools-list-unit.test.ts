/**
 * `toolsList` unit coverage — the pure inventory builder (ADR-0041). The
 * existing `tools-list.test.ts` drives the same logic through the subprocess
 * surface (coverage-invisible); this exercises the function directly: the
 * admitted/loaded set, the marker-scan manifest-only set, source labelling,
 * shadow-marking, and the scope filters. A temp HOME + cwd keep the two install
 * hosts hermetic and empty unless a fixture writes into them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectPaths, resolveUserPaths } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOOL_DOMAIN } from '../commands/plugin/domain-resolution.js';
import { toolsList } from '../commands/tools/list.js';

import type { ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

let projectDir: string;
let fakeHome: string;
let homeBackup: string | undefined;

/** Write a marker+manifest tool package into a host's node_modules dir. */
function writeToolPackage(hostDir: string, pkgName: string, toolId: string): void {
  const pkgDir = join(hostDir, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '4.5.6',
      private: true,
      type: 'module',
      main: './index.js',
      opensipTools: {
        kind: 'tool',
        id: toolId,
        identity: { name: toolId },
        apiVersion: 1,
        commands: [{ name: toolId, description: 'fixture' }],
      },
    }),
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const tool = 1;');
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ost-toolslist-unit-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ost-toolslist-unit-home-'));
  homeBackup = process.env.HOME;
  // resolveUserPaths reads HOME; redirect it so the user-global host is hermetic.
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function prov(over: Partial<ToolProvenance> = {}): ToolProvenance {
  return {
    id: 'fit',
    version: '0.1.0',
    source: 'bundled',
    ...over,
  } as ToolProvenance;
}

function manifest(over: Partial<ToolPluginManifest> = {}): ToolPluginManifest {
  return {
    id: 'fit',
    version: '0.1.0',
    apiVersion: 1,
    commands: [{ name: 'fit', description: 'run fit' }],
    ...over,
  } as ToolPluginManifest;
}

describe('toolsList — loaded (admitted) set', () => {
  it('returns an empty inventory when nothing is admitted or installed', () => {
    const result = toolsList({ cwd: projectDir });
    expect(result.type).toBe('tools-list');
    expect(result.tools).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('maps an admitted bundled tool with its paired manifest commands', () => {
    const result = toolsList({
      cwd: projectDir,
      provenance: [prov({ id: 'fit', packageName: undefined })],
      manifests: [manifest({ commands: [{ name: 'fit', description: 'x' }] })],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      id: 'fit',
      source: 'bundled',
      status: 'loaded',
      commands: ['fit'],
    });
    // No packageName on a bundled tool → the field is omitted, not null.
    expect(result.tools[0]).not.toHaveProperty('packageName');
  });

  it('labels provenance by its declared project-local / user-global source', () => {
    const result = toolsList({
      cwd: projectDir,
      provenance: [
        prov({ id: 'pl', packageName: '@x/pl', source: 'project-local' }),
        prov({ id: 'ug', packageName: '@x/ug', source: 'user-global' }),
      ],
      manifests: [manifest(), manifest()],
    });
    const byId = Object.fromEntries(result.tools.map((t) => [t.id, t.source]));
    expect(byId.pl).toBe('project');
    expect(byId.ug).toBe('global');
  });

  it('falls back to empty commands when a loaded tool has no paired manifest', () => {
    const result = toolsList({
      cwd: projectDir,
      provenance: [prov({ id: 'nomani', source: 'bundled' })],
      manifests: [], // shorter than provenance → manifests[0] is undefined
    });
    expect(result.tools[0]?.commands).toEqual([]);
  });

  it('labels installed provenance by the host dir its package resolved into', () => {
    const projectHost = resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
    const globalHost = resolveUserPaths().pluginsDir(TOOL_DOMAIN);
    const result = toolsList({
      cwd: projectDir,
      provenance: [
        prov({
          id: 'proj-tool',
          packageName: '@x/proj',
          source: 'installed',
          resolvedPath: join(projectHost, 'node_modules', '@x/proj'),
        }),
        prov({
          id: 'glob-tool',
          packageName: '@x/glob',
          source: 'installed',
          resolvedPath: join(globalHost, 'node_modules', '@x/glob'),
        }),
        prov({ id: 'wild-tool', packageName: '@x/wild', source: 'installed' }),
      ],
      manifests: [manifest(), manifest(), manifest()],
    });
    const byId = Object.fromEntries(result.tools.map((t) => [t.id, t.source]));
    expect(byId['proj-tool']).toBe('project');
    expect(byId['glob-tool']).toBe('global');
    // No resolvedPath → defaults to the broader "global" visibility claim.
    expect(byId['wild-tool']).toBe('global');
  });
});

describe('toolsList — installed-but-not-loaded marker scan', () => {
  it('adds manifest-only rows from the project and global hosts', () => {
    const projectHost = resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
    const globalHost = resolveUserPaths().pluginsDir(TOOL_DOMAIN);
    writeToolPackage(projectHost, '@x/installed-proj', 'installed-proj');
    writeToolPackage(globalHost, '@x/installed-glob', 'installed-glob');

    const result = toolsList({ cwd: projectDir });
    const proj = result.tools.find((t) => t.id === 'installed-proj');
    const glob = result.tools.find((t) => t.id === 'installed-glob');
    expect(proj).toMatchObject({
      source: 'project',
      status: 'manifest-only',
      version: '4.5.6',
    });
    expect(glob).toMatchObject({ source: 'global', status: 'manifest-only' });
  });

  it('skips a host package that is already in the loaded set (no duplicate row)', () => {
    const projectHost = resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
    writeToolPackage(projectHost, '@x/dup', 'dup-tool');
    const result = toolsList({
      cwd: projectDir,
      provenance: [
        prov({
          id: 'dup-tool',
          packageName: '@x/dup',
          source: 'installed',
          resolvedPath: '',
        }),
      ],
      manifests: [manifest()],
    });
    expect(result.tools.filter((t) => t.id === 'dup-tool')).toHaveLength(1);
    expect(result.tools[0]?.status).toBe('loaded');
  });
});

describe('toolsList — shadow-marking and scope filters', () => {
  it('marks a global row shadowed when a project row shares its id', () => {
    const projectHost = resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
    const globalHost = resolveUserPaths().pluginsDir(TOOL_DOMAIN);
    writeToolPackage(projectHost, '@x/proj-shadow', 'shadow');
    writeToolPackage(globalHost, '@x/glob-shadow', 'shadow');

    const all = toolsList({ cwd: projectDir });
    const shadows = all.tools.filter((t) => t.id === 'shadow');
    expect(shadows).toHaveLength(2);
    expect(shadows.find((t) => t.source === 'global')?.shadowed).toBe(true);
    expect(shadows.find((t) => t.source === 'project')?.shadowed).toBeUndefined();
  });

  it('honors --project and --global scope filters', () => {
    const projectHost = resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
    const globalHost = resolveUserPaths().pluginsDir(TOOL_DOMAIN);
    writeToolPackage(projectHost, '@x/p', 'p-tool');
    writeToolPackage(globalHost, '@x/g', 'g-tool');

    const projectOnly = toolsList({ cwd: projectDir, project: true });
    expect(projectOnly.tools.every((t) => t.source === 'project')).toBe(true);
    expect(projectOnly.tools.map((t) => t.id)).toEqual(['p-tool']);

    const globalOnly = toolsList({ cwd: projectDir, global: true });
    expect(globalOnly.tools.every((t) => t.source === 'global')).toBe(true);
    expect(globalOnly.tools.map((t) => t.id)).toEqual(['g-tool']);
    expect(globalOnly.totalCount).toBe(1);
  });
});
