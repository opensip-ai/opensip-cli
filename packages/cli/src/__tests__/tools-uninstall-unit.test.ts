/**
 * `toolsUninstall` unit coverage (ADR-0041) — the scope-aware, identity-
 * resolving removal. The resolution logic (bundled rejection, no-match,
 * cross-tool ambiguity, both-scopes disambiguation, scope selection) is pure
 * and driven by fixture install hosts; only the terminal `removeToolPlugin`
 * shells out to npm, so it is mocked to assert the success + removal-failure
 * branches without a real install. The existing subprocess test is
 * coverage-invisible; this exercises the function directly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectPaths, resolveUserPaths } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_DOMAIN } from '../commands/plugin/domain-resolution.js';

import type { ToolProvenance } from '@opensip-cli/core';

// removeToolPlugin shells out to `npm uninstall`; mock it so the success and
// removal-failure branches are reachable without touching a real host.
const removeToolPlugin = vi.fn();
vi.mock('../commands/plugin-host-ops.js', () => ({
  removeToolPlugin: (...args: unknown[]) => removeToolPlugin(...args),
}));

// Imported after vi.mock so the mocked dependency is wired in.
const { toolsUninstall } = await import('../commands/tools/uninstall.js');

let projectDir: string;
let fakeHome: string;
let homeBackup: string | undefined;

function writeToolPackage(hostDir: string, pkgName: string, toolId: string): void {
  const pkgDir = join(hostDir, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      opensipTools: {
        kind: 'tool',
        id: toolId,
        apiVersion: 1,
        commands: [{ name: `${toolId}-cmd`, description: 'fixture' }],
      },
    }),
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const tool = 1;');
}

function projectHost(): string {
  return resolveProjectPaths(projectDir).pluginsDir(TOOL_DOMAIN);
}
function globalHost(): string {
  return resolveUserPaths().pluginsDir(TOOL_DOMAIN);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ost-uninstall-unit-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ost-uninstall-unit-home-'));
  homeBackup = process.env.HOME;
  process.env.HOME = fakeHome;
  removeToolPlugin.mockReset();
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function bundled(id: string): ToolProvenance {
  return { id, version: '0.1.0', source: 'bundled' } as ToolProvenance;
}

describe('toolsUninstall — rejection / resolution failures (no shell-out)', () => {
  it('refuses to uninstall a bundled tool', () => {
    const result = toolsUninstall({ target: 'fit', cwd: projectDir, provenance: [bundled('fit')] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bundled tool/);
    expect(removeToolPlugin).not.toHaveBeenCalled();
  });

  it('fails when no installed tool matches the target', () => {
    const result = toolsUninstall({ target: 'ghost', cwd: projectDir });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no installed tool matches/);
  });

  it('reports cross-tool ambiguity when id and package name resolve to different tools', () => {
    // target 'collide' matches pkg A by id and pkg B by package name → two ids.
    writeToolPackage(projectHost(), 'collide', 'tool-a'); // packageName === target
    writeToolPackage(globalHost(), '@x/b', 'collide'); // id === target
    const result = toolsUninstall({ target: 'collide', cwd: projectDir });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambiguous across different tools/);
  });

  it('requires a scope flag when the same tool is installed in both scopes', () => {
    writeToolPackage(projectHost(), '@x/dual', 'dual');
    writeToolPackage(globalHost(), '@x/dual', 'dual');
    const result = toolsUninstall({ target: 'dual', cwd: projectDir });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/installed in BOTH scopes/);
    expect(removeToolPlugin).not.toHaveBeenCalled();
  });

  it('fails when the requested scope has no matching install', () => {
    writeToolPackage(projectHost(), '@x/proj-only', 'proj-only');
    const result = toolsUninstall({ target: 'proj-only', cwd: projectDir, global: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed in the global scope/);
  });
});

describe('toolsUninstall — removal (mocked npm boundary)', () => {
  it('removes a single-scope install and reports the resolved identity', () => {
    writeToolPackage(projectHost(), '@x/solo', 'solo');
    removeToolPlugin.mockReturnValue({
      type: 'plugin-remove',
      packageName: '@x/solo',
      success: true,
    });
    const result = toolsUninstall({ target: 'solo', cwd: projectDir });
    expect(result.success).toBe(true);
    expect(result.removed).toEqual({ id: 'solo', packageName: '@x/solo', scope: 'project' });
    expect(removeToolPlugin).toHaveBeenCalledWith('@x/solo', projectDir, true);
  });

  it('disambiguates by --global when installed in both scopes', () => {
    writeToolPackage(projectHost(), '@x/dual', 'dual');
    writeToolPackage(globalHost(), '@x/dual', 'dual');
    removeToolPlugin.mockReturnValue({
      type: 'plugin-remove',
      packageName: '@x/dual',
      success: true,
    });
    const result = toolsUninstall({ target: 'dual', cwd: projectDir, global: true });
    expect(result.success).toBe(true);
    expect(result.removed?.scope).toBe('global');
    expect(removeToolPlugin).toHaveBeenCalledWith('@x/dual', projectDir, false);
  });

  it('surfaces a failed removal from the host op', () => {
    writeToolPackage(projectHost(), '@x/solo', 'solo');
    removeToolPlugin.mockReturnValue({
      type: 'plugin-remove',
      packageName: '@x/solo',
      success: false,
      error: 'npm uninstall failed',
    });
    const result = toolsUninstall({ target: 'solo', cwd: projectDir });
    expect(result.success).toBe(false);
    expect(result.error).toBe('npm uninstall failed');
  });
});
