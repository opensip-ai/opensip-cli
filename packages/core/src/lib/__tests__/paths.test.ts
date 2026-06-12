/**
 * @fileoverview Path resolver contract tests.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveProjectPaths, resolveUserPaths } from '../paths.js';

// eslint-disable-next-line sonarjs/publicly-writable-directories -- string-only fixture; resolver is pure (no fs touch)
const PROJECT = '/tmp/test-project';

describe('resolveProjectPaths', () => {
  it('places the config at the project root', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.configFile).toBe(join(PROJECT, 'opensip-cli.config.yml'));
  });

  it('resolves user-source plugin dirs generically via userPluginDir(domain, kind)', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.userSourceDir).toBe(join(PROJECT, 'opensip-cli'));
    expect(p.userPluginDir('fit', 'checks')).toBe(join(PROJECT, 'opensip-cli', 'fit', 'checks'));
    expect(p.userPluginDir('fit', 'recipes')).toBe(
      join(PROJECT, 'opensip-cli', 'fit', 'recipes'),
    );
    expect(p.userPluginDir('sim', 'scenarios')).toBe(
      join(PROJECT, 'opensip-cli', 'sim', 'scenarios'),
    );
    expect(p.userPluginDir('sim', 'recipes')).toBe(
      join(PROJECT, 'opensip-cli', 'sim', 'recipes'),
    );
  });

  it('places runtime state under opensip-cli/.runtime', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.runtimeDir).toBe(join(PROJECT, 'opensip-cli', '.runtime'));
    expect(p.sessionsDir).toBe(join(p.runtimeDir, 'sessions'));
    expect(p.reportsDir).toBe(join(p.runtimeDir, 'reports'));
    expect(p.logsDir).toBe(join(p.runtimeDir, 'logs'));
    expect(p.cacheDir).toBe(join(p.runtimeDir, 'cache'));
  });

  it('resolves per-domain plugin install dirs under runtime/plugins', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.pluginsDir('fit')).toBe(join(p.runtimeDir, 'plugins', 'fit'));
    expect(p.pluginsDir('sim')).toBe(join(p.runtimeDir, 'plugins', 'sim'));
  });

  it('places TRACKED authored Tool sidecars under opensip-cli/tools (beside fit/sim, NOT under .runtime)', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.authoredToolsDir).toBe(join(PROJECT, 'opensip-cli', 'tools'));
    // Load-bearing: the authored tools root is the tracked sibling of fit/sim,
    // never under the gitignored .runtime tree.
    expect(p.authoredToolsDir.startsWith(p.runtimeDir)).toBe(false);
  });
});

describe('resolveUserPaths', () => {
  it('places user-level config at ~/.opensip-cli/config.yml', () => {
    const u = resolveUserPaths();
    expect(u.userHomeDir).toBe(join(homedir(), '.opensip-cli'));
    expect(u.configFile).toBe(join(u.userHomeDir, 'config.yml'));
  });

  it('places user-global plugins under ~/.opensip-cli/plugins/<domain>', () => {
    const u = resolveUserPaths();
    expect(u.pluginsDir('tool')).toBe(join(u.userHomeDir, 'plugins', 'tool'));
  });

  it('places global authored Tool sidecars under ~/.opensip-cli/tools (trusted-by-default)', () => {
    const u = resolveUserPaths();
    expect(u.authoredToolsDir).toBe(join(u.userHomeDir, 'tools'));
  });
});
