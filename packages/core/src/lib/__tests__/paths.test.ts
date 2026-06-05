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
    expect(p.configFile).toBe(join(PROJECT, 'opensip-tools.config.yml'));
  });

  it('resolves user-source plugin dirs generically via userPluginDir(domain, kind)', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.userSourceDir).toBe(join(PROJECT, 'opensip-tools'));
    expect(p.userPluginDir('fit', 'checks')).toBe(join(PROJECT, 'opensip-tools', 'fit', 'checks'));
    expect(p.userPluginDir('fit', 'recipes')).toBe(join(PROJECT, 'opensip-tools', 'fit', 'recipes'));
    expect(p.userPluginDir('sim', 'scenarios')).toBe(join(PROJECT, 'opensip-tools', 'sim', 'scenarios'));
    expect(p.userPluginDir('sim', 'recipes')).toBe(join(PROJECT, 'opensip-tools', 'sim', 'recipes'));
  });

  it('places runtime state under opensip-tools/.runtime', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.runtimeDir).toBe(join(PROJECT, 'opensip-tools', '.runtime'));
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
});

describe('resolveUserPaths', () => {
  it('places user-level config at ~/.opensip-tools/config.yml', () => {
    const u = resolveUserPaths();
    expect(u.userHomeDir).toBe(join(homedir(), '.opensip-tools'));
    expect(u.configFile).toBe(join(u.userHomeDir, 'config.yml'));
  });

  it('places user-global plugins under ~/.opensip-tools/plugins/<domain>', () => {
    const u = resolveUserPaths();
    expect(u.pluginsDir('tool')).toBe(join(u.userHomeDir, 'plugins', 'tool'));
  });
});

