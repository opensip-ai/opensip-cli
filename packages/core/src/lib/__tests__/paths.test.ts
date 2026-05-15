/**
 * @fileoverview Path resolver contract tests.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveLegacyV2Paths,
  resolveProjectPaths,
  resolveUserPaths,
} from '../paths.js';

// eslint-disable-next-line sonarjs/publicly-writable-directories -- string-only fixture; resolver is pure (no fs touch)
const PROJECT = '/tmp/test-project';

describe('resolveProjectPaths', () => {
  it('places the config at the project root', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.configFile).toBe(join(PROJECT, 'opensip-tools.config.yml'));
  });

  it('places user-source in opensip-tools/{fit,sim}/{checks,recipes,scenarios}', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.userSourceDir).toBe(join(PROJECT, 'opensip-tools'));
    expect(p.fitChecksDir).toBe(join(PROJECT, 'opensip-tools', 'fit', 'checks'));
    expect(p.fitRecipesDir).toBe(join(PROJECT, 'opensip-tools', 'fit', 'recipes'));
    expect(p.simScenariosDir).toBe(join(PROJECT, 'opensip-tools', 'sim', 'scenarios'));
    expect(p.simRecipesDir).toBe(join(PROJECT, 'opensip-tools', 'sim', 'recipes'));
  });

  it('places runtime state under opensip-tools/.runtime', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.runtimeDir).toBe(join(PROJECT, 'opensip-tools', '.runtime'));
    expect(p.sessionsDir).toBe(join(p.runtimeDir, 'sessions'));
    expect(p.reportsDir).toBe(join(p.runtimeDir, 'reports'));
    expect(p.logsDir).toBe(join(p.runtimeDir, 'logs'));
    expect(p.cacheDir).toBe(join(p.runtimeDir, 'cache'));
    expect(p.baselinePath).toBe(join(p.runtimeDir, 'baseline.sarif'));
    expect(p.migrationMarker).toBe(join(p.runtimeDir, 'migrated-from-v2'));
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
});

describe('resolveLegacyV2Paths', () => {
  it('exposes the v2 hidden project dir for migration purposes', () => {
    const v2 = resolveLegacyV2Paths(PROJECT);
    expect(v2.projectV2Dir).toBe(join(PROJECT, '.opensip-tools'));
    expect(v2.projectV2FitDir).toBe(join(v2.projectV2Dir, 'fit'));
    expect(v2.projectV2SimDir).toBe(join(v2.projectV2Dir, 'sim'));
    expect(v2.projectV2BaselinePath).toBe(join(v2.projectV2Dir, 'baseline.sarif'));
  });

  it('exposes the v2 user-global session/log dirs for migration', () => {
    const v2 = resolveLegacyV2Paths(PROJECT);
    expect(v2.userV2SessionsDir).toBe(join(homedir(), '.opensip-tools', 'sessions'));
    expect(v2.userV2LogsDir).toBe(join(homedir(), '.opensip-tools', 'logs'));
    expect(v2.userV2PluginDir('fit')).toBe(join(homedir(), '.opensip-tools', 'fit'));
  });
});
