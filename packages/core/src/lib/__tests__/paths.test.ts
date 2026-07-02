/**
 * @fileoverview Path resolver contract tests.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPathInside, resolveProjectPaths, resolveUserPaths, toPosixRelative } from '../paths.js';

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
    expect(p.userPluginDir('fit', 'recipes')).toBe(join(PROJECT, 'opensip-cli', 'fit', 'recipes'));
    expect(p.userPluginDir('sim', 'scenarios')).toBe(
      join(PROJECT, 'opensip-cli', 'sim', 'scenarios'),
    );
    expect(p.userPluginDir('sim', 'recipes')).toBe(join(PROJECT, 'opensip-cli', 'sim', 'recipes'));
  });

  it('places runtime state under opensip-cli/.runtime', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.runtimeDir).toBe(join(PROJECT, 'opensip-cli', '.runtime'));
    expect(p.sessionsDir).toBe(join(p.runtimeDir, 'sessions'));
    expect(p.reportsDir).toBe(join(p.runtimeDir, 'reports'));
    expect(p.logsDir).toBe(join(p.runtimeDir, 'logs'));
    expect(p.cacheDir).toBe(join(p.runtimeDir, 'cache'));
  });

  it('resolves the host-owned artifact store and per-tool subdirs', () => {
    const p = resolveProjectPaths(PROJECT);
    expect(p.artifactsDir).toBe(join(p.runtimeDir, 'artifacts'));
    expect(p.artifactDir('gitleaks')).toBe(join(p.artifactsDir, 'gitleaks'));
    expect(p.artifactDir('osv-scanner')).toBe(join(p.artifactsDir, 'osv-scanner'));
    // Load-bearing: the artifact store is gitignored runtime state, never tracked.
    expect(p.artifactsDir.startsWith(p.runtimeDir)).toBe(true);
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

describe('isPathInside', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'opensip-paths-inside-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true for a child path inside the parent', () => {
    const child = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(child, { recursive: true });
    expect(isPathInside(child, testDir)).toBe(true);
  });

  it('returns false for paths outside the parent', () => {
    const outside = mkdtempSync(join(tmpdir(), 'opensip-paths-outside-'));
    try {
      expect(isPathInside(outside, testDir)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns false when the child path does not exist', () => {
    expect(isPathInside(join(testDir, 'missing'), testDir)).toBe(false);
  });

  it('returns false when a symlinked directory resolves outside the parent', () => {
    if (platform() === 'win32') return;

    const outside = mkdtempSync(join(tmpdir(), 'opensip-paths-escape-'));
    const container = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(container, { recursive: true });
    try {
      symlinkSync(outside, join(container, 'escape'));
      expect(isPathInside(join(container, 'escape'), container)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('toPosixRelative', () => {
  it('preserves already-relative paths in POSIX form', () => {
    expect(toPosixRelative('/proj', 'src/pkg/file.ts')).toBe('src/pkg/file.ts');
  });

  it('makes absolute paths relative to cwd in POSIX form', () => {
    const cwd = resolve('/proj');
    expect(toPosixRelative(cwd, resolve('/proj/packages/cli/src/index.ts'))).toBe(
      'packages/cli/src/index.ts',
    );
  });
});
