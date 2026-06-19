/**
 * Project-local executable-tool trust policy (release 2.8.0, Phase 3
 * Task 3.2): deny-by-default, admit-with-allowlist. A disallowed
 * project-local tool is fail-closed (PluginIncompatibleError → exit 5)
 * WITHOUT its module ever being imported.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { PluginIncompatibleError } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { admitProjectLocalTool, admitUserGlobalTool } from '../bootstrap/register-tools.js';
import {
  INSTALLED_TOOL_ALLOWLIST_ENV,
  isInstalledToolTrusted,
  isProjectLocalToolTrusted,
  PROJECT_TOOL_ALLOWLIST_ENV,
} from '../bootstrap/tool-trust.js';

const SIDECAR = 'opensip-tool.manifest.json';

function stageProjectLocalTool(id: string, apiVersion?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-projlocal-'));
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    kind: 'tool',
    id,
    name: `${id} tool`,
    version: '1.0.0',
    commands: [{ name: id, description: `the ${id} command` }],
  };
  if (apiVersion !== undefined) manifest.apiVersion = apiVersion;
  writeFileSync(join(dir, SIDECAR), JSON.stringify(manifest), 'utf8');
  return dir;
}

describe('isInstalledToolTrusted (deny-by-default allowlist)', () => {
  it('denies by default when the allowlist env is unset/empty', () => {
    expect(isInstalledToolTrusted('my-plugin', {})).toBe(false);
    expect(isInstalledToolTrusted('my-plugin', { [INSTALLED_TOOL_ALLOWLIST_ENV]: '' })).toBe(false);
  });

  it('admits an id present in the comma/space-separated allowlist', () => {
    const env = { [INSTALLED_TOOL_ALLOWLIST_ENV]: 'my-plugin, other-tool' };
    expect(isInstalledToolTrusted('my-plugin', env)).toBe(true);
    expect(isInstalledToolTrusted('other-tool', env)).toBe(true);
    expect(isInstalledToolTrusted('unknown', env)).toBe(false);
  });

  it('admits all on the wildcard', () => {
    expect(isInstalledToolTrusted('anything', { [INSTALLED_TOOL_ALLOWLIST_ENV]: '*' })).toBe(true);
  });
});

describe('isProjectLocalToolTrusted (deny-by-default allowlist)', () => {
  it('denies by default when the allowlist env is unset/empty', () => {
    expect(isProjectLocalToolTrusted('my-audit', {})).toBe(false);
    expect(isProjectLocalToolTrusted('my-audit', { [PROJECT_TOOL_ALLOWLIST_ENV]: '' })).toBe(false);
  });

  it('admits an id present in the comma/space-separated allowlist', () => {
    const env = { [PROJECT_TOOL_ALLOWLIST_ENV]: 'my-audit, my-lint' };
    expect(isProjectLocalToolTrusted('my-audit', env)).toBe(true);
    expect(isProjectLocalToolTrusted('my-lint', env)).toBe(true);
    expect(isProjectLocalToolTrusted('other', env)).toBe(false);
  });

  it('admits all on the wildcard', () => {
    expect(isProjectLocalToolTrusted('anything', { [PROJECT_TOOL_ALLOWLIST_ENV]: '*' })).toBe(true);
  });
});

describe('admitProjectLocalTool — trust gate precedes import', () => {
  const staged: string[] = [];
  afterEach(() => {
    for (const d of staged.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('fail-closes a disallowed project-local tool (no import) → exit 5', () => {
    const dir = stageProjectLocalTool('untrusted-tool');
    staged.push(dir);
    try {
      admitProjectLocalTool({ dir, env: {} });
      expect.unreachable('expected a PluginIncompatibleError');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginIncompatibleError);
      const e = error as PluginIncompatibleError;
      expect(mapToolErrorToExitCode(e)).toBe(EXIT_CODES.PLUGIN_INCOMPATIBLE);
      expect(e.diagnostic).toMatch(/deny-by-default/);
    }
  });

  it('admits an allowlisted, in-range project-local tool with provenance', () => {
    const dir = stageProjectLocalTool('trusted-tool', 1);
    staged.push(dir);
    const { provenance, manifest } = admitProjectLocalTool({
      dir,
      env: { [PROJECT_TOOL_ALLOWLIST_ENV]: 'trusted-tool' },
    });
    expect(provenance.source).toBe('project-local');
    expect(provenance.id).toBe('trusted-tool');
    expect(provenance.manifestHash.length).toBeGreaterThan(0);
    // The admission now returns the loaded manifest so the discovery walk can
    // run the drift guard + seed capabilities without a second read.
    expect(manifest.id).toBe('trusted-tool');
  });

  it('fail-closes a missing/malformed sidecar manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-projlocal-empty-'));
    staged.push(dir);
    expect(() =>
      admitProjectLocalTool({ dir, env: { [PROJECT_TOOL_ALLOWLIST_ENV]: '*' } }),
    ).toThrow(PluginIncompatibleError);
  });

  it('fail-closes an allowlisted but compatibility-incompatible tool', () => {
    // apiVersion 999 is out of range vs the engine epoch (1) → incompatible,
    // and an allowlisted project-local tool is explicitlyRequested → fail-closed.
    const dir = stageProjectLocalTool('future-tool', 999);
    staged.push(dir);
    try {
      admitProjectLocalTool({ dir, env: { [PROJECT_TOOL_ALLOWLIST_ENV]: 'future-tool' } });
      expect.unreachable('expected a PluginIncompatibleError');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginIncompatibleError);
      expect((error as PluginIncompatibleError).diagnostic).toMatch(/plugin API/);
    }
  });
});

describe('admitUserGlobalTool — trusted-by-default (no allowlist gate)', () => {
  const staged: string[] = [];
  afterEach(() => {
    for (const d of staged.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('admits a global authored tool WITHOUT an allowlist, provenance user-global', () => {
    const dir = stageProjectLocalTool('global-tool', 1);
    staged.push(dir);
    const { provenance, manifest } = admitUserGlobalTool({ dir });
    expect(provenance.source).toBe('user-global');
    expect(provenance.id).toBe('global-tool');
    expect(provenance.manifestHash.length).toBeGreaterThan(0);
    expect(manifest.id).toBe('global-tool');
  });

  it('fail-closes a missing/malformed sidecar (the user explicitly placed it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-global-empty-'));
    staged.push(dir);
    expect(() => admitUserGlobalTool({ dir })).toThrow(PluginIncompatibleError);
  });

  it('fail-closes a compatibility-incompatible global tool', () => {
    const dir = stageProjectLocalTool('future-global', 999);
    staged.push(dir);
    try {
      admitUserGlobalTool({ dir });
      expect.unreachable('expected a PluginIncompatibleError');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginIncompatibleError);
      expect((error as PluginIncompatibleError).diagnostic).toMatch(/plugin API/);
    }
  });
});
