import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  findInstalledName: vi.fn(() => '@org/plugin'),
  installMissingPeers: vi.fn(),
  readHostDependencies: vi.fn(() => new Set<string>()),
}));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('../commands/plugin/host-dir.js', () => ({
  ensurePluginHostDir: vi.fn(),
  ensureUserPluginHostDir: vi.fn(),
  findInstalledName: mocks.findInstalledName,
  HOST_PACKAGE_JSON: 'package.json',
  installMissingPeers: mocks.installMissingPeers,
  readHostDependencies: mocks.readHostDependencies,
}));

import { npmInstallIntoHost, npmUninstallFromHost } from '../commands/plugin-host-ops.js';

describe('plugin host npm effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs the requested package without scripts or audit traffic', () => {
    const outcome = npmInstallIntoHost('/plugin-host', '/fixtures/pack.tgz');

    expect(outcome).toEqual({ ok: true, installedName: '@org/plugin' });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '/fixtures/pack.tgz'],
      expect.objectContaining({ cwd: '/plugin-host' }),
    );
    expect(mocks.installMissingPeers).toHaveBeenCalledOnce();
  });

  it('uninstalls without executing package lifecycle scripts', () => {
    expect(npmUninstallFromHost('/plugin-host', '@org/plugin')).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'npm',
      ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', '@org/plugin'],
      expect.objectContaining({ cwd: '/plugin-host' }),
    );
  });
});
