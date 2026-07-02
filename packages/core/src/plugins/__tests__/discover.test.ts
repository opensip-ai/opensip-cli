import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { discoverPlugins } from '../discover.js';

import type { PluginLayout } from '../types.js';

/** Layouts under test — fit (checks/recipes), sim (scenarios/recipes), lang (none). */
const FIT_LAYOUT: PluginLayout = {
  domain: 'fit',
  userSubdirs: ['checks', 'recipes'],
};
const SIM_LAYOUT: PluginLayout = {
  domain: 'sim',
  userSubdirs: ['scenarios', 'recipes'],
};
const LANG_LAYOUT: PluginLayout = { domain: 'lang', userSubdirs: [] };

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-plugins-test-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Helpers to build the project layout in the test tmpdir:
 *
 *   <testDir>/opensip-cli/<tool>/<kind>/<file>.mjs
 *   <testDir>/opensip-cli/<tool>/<kind>/<file>.js
 *   <testDir>/opensip-cli/.runtime/plugins/<domain>/...
 *   <testDir>/opensip-cli.config.yml  (declares plugins.<domain>)
 */

function fitChecksDir(): string {
  return join(testDir, 'opensip-cli', 'fit', 'checks');
}
function fitRecipesDir(): string {
  return join(testDir, 'opensip-cli', 'fit', 'recipes');
}
function simScenariosDir(): string {
  return join(testDir, 'opensip-cli', 'sim', 'scenarios');
}
function fitPluginsDir(): string {
  return join(testDir, 'opensip-cli', '.runtime', 'plugins', 'fit');
}
function writeConfig(yaml: string): void {
  writeFileSync(join(testDir, 'opensip-cli.config.yml'), yaml);
}

/** Build a `plugins.fit:` config block with the given declared deps. */
function setupPluginsConfig(deps: string[]): void {
  const list = deps.map((d) => `    - "${d}"`).join('\n');
  writeConfig(`plugins:\n  fit:\n${list}\n`);
}

describe('discoverPlugins', () => {
  it('returns empty array when projectDir is undefined', () => {
    expect(discoverPlugins(FIT_LAYOUT)).toEqual([]);
  });

  it('returns empty array when no opensip-cli/ directory exists', () => {
    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });

  it('returns empty array for `lang` (no subdir model)', () => {
    mkdirSync(join(testDir, 'opensip-cli', 'lang'), { recursive: true });
    expect(discoverPlugins(LANG_LAYOUT, testDir)).toEqual([]);
  });

  describe('user-source files (no config opt-in needed)', () => {
    it('discovers .mjs files in opensip-cli/fit/checks/', () => {
      mkdirSync(fitChecksDir(), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'my-check.mjs'), 'export const checks = []');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'file',
        source: 'my-check.mjs',
      });
      expect(result[0]?.namespace).toContain('my-check');
    });

    it('discovers .js files in opensip-cli/fit/checks/', () => {
      mkdirSync(fitChecksDir(), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'plugin.js'), 'export const checks = []');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('plugin.js');
    });

    it('discovers files in BOTH opensip-cli/fit/checks/ and opensip-cli/fit/recipes/', () => {
      mkdirSync(fitChecksDir(), { recursive: true });
      mkdirSync(fitRecipesDir(), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'my-check.mjs'), 'export const checks = []');
      writeFileSync(join(fitRecipesDir(), 'my-recipe.mjs'), 'export const recipes = []');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(2);
      const sources = result.map((p) => p.source).sort();
      expect(sources).toEqual(['my-check.mjs', 'my-recipe.mjs']);
    });

    it('namespaces sim files under sim/scenarios distinctly from sim/recipes', () => {
      mkdirSync(simScenariosDir(), { recursive: true });
      writeFileSync(join(simScenariosDir(), 'load.mjs'), 'export const scenarios = []');

      const result = discoverPlugins(SIM_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.namespace).toContain('sim/scenarios/load');
    });

    it('ignores non-js files', () => {
      mkdirSync(fitChecksDir(), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'readme.txt'), 'not a plugin');
      writeFileSync(join(fitChecksDir(), 'data.json'), '{}');

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('discovers nested loose files with relative source and namespace', () => {
      mkdirSync(join(fitChecksDir(), 'docs'), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'docs', 'audience.mjs'), 'export const checks = []');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'file',
        source: 'docs/audience.mjs',
        namespace: 'fit/checks/docs/audience',
      });
    });
  });

  describe('npm-installed plugins (config opt-in required)', () => {
    it('does NOT auto-load packages when plugins.fit is not declared', () => {
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'silent-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'silent-pkg', main: './index.js' }),
      );
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []');

      // Config is absent → no opt-in → package not loaded
      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('discovers packages listed in plugins.fit when installed', () => {
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'my-plugin');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'my-plugin', main: './index.js' }),
      );
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []');

      setupPluginsConfig(['my-plugin']);

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'package',
        namespace: 'my-plugin',
        source: 'my-plugin',
      });
    });

    it('discovers scoped packages declared in plugins.fit', () => {
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', '@scope', 'checks');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@scope/checks',
          main: './dist/index.js',
        }),
      );
      mkdirSync(join(pkgDir, 'dist'));
      writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export const checks = []');

      setupPluginsConfig(['@scope/checks']);

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'package',
        namespace: '@scope/checks',
      });
    });

    it('skips packages that are listed but not installed', () => {
      setupPluginsConfig(['ghost-package']);
      // No node_modules/ghost-package/ exists
      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('skips packages without an entry point', () => {
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'broken');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'broken',
          main: './nonexistent.js',
        }),
      );
      setupPluginsConfig(['broken']);

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('uses exports["."] when available', () => {
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'exports-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'exports-pkg',
          exports: { '.': './lib/main.js' },
        }),
      );
      mkdirSync(join(pkgDir, 'lib'));
      writeFileSync(join(pkgDir, 'lib', 'main.js'), 'export const checks = []');

      setupPluginsConfig(['exports-pkg']);

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.entryPoint).toContain('lib/main.js');
    });
  });

  describe('security: path traversal and symlink containment', () => {
    it('rejects plugin names containing .. (would traverse out of node_modules)', () => {
      // The plugin list comes from opensip-cli.config.yml. A malicious
      // (or careless) entry like "../escapee" would, without the
      // containment check, resolve relative to node_modules and pull in
      // arbitrary code.
      const pluginsRoot = fitPluginsDir();
      mkdirSync(join(pluginsRoot, 'node_modules'), { recursive: true });
      const escapee = join(pluginsRoot, 'node_modules', '..', 'escapee');
      mkdirSync(escapee, { recursive: true });
      writeFileSync(
        join(escapee, 'package.json'),
        JSON.stringify({ name: 'escapee', main: './index.js' }),
      );
      writeFileSync(join(escapee, 'index.js'), 'export const checks = []');

      setupPluginsConfig(['../escapee']);

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('rejects absolute-path plugin names', () => {
      mkdirSync(fitPluginsDir(), { recursive: true });
      setupPluginsConfig(['/etc/passwd']);
      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('rejects loose-file plugins that are symlinks pointing outside the source dir', () => {
      // Skip on Windows where symlink creation needs elevated privileges
      // in CI and isn't part of the threat model.
      if (platform() === 'win32') return;

      mkdirSync(fitChecksDir(), { recursive: true });

      const outsideTarget = join(testDir, 'evil-target.mjs');
      writeFileSync(outsideTarget, 'export const checks = []');

      const symlinkPath = join(fitChecksDir(), 'looks-legit.mjs');
      symlinkSync(outsideTarget, symlinkPath);

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });

    it('accepts symlinks that resolve INSIDE the source dir (pnpm-style)', () => {
      if (platform() === 'win32') return;

      mkdirSync(fitChecksDir(), { recursive: true });

      const realFile = join(fitChecksDir(), 'real-plugin.mjs');
      writeFileSync(realFile, 'export const checks = []');

      const symlinkPath = join(fitChecksDir(), 'aliased.mjs');
      symlinkSync(realFile, symlinkPath);

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.every((p) => p.type === 'file')).toBe(true);
    });

    it('rejects nested directories that symlink outside the source dir', () => {
      if (platform() === 'win32') return;

      const outside = mkdtempSync(join(tmpdir(), 'opensip-discover-outside-'));
      try {
        writeFileSync(join(outside, 'outside.mjs'), 'export const checks = []');
        mkdirSync(fitChecksDir(), { recursive: true });
        symlinkSync(outside, join(fitChecksDir(), 'escape'));

        expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('ignores dangling file symlinks that do not resolve to a regular file', () => {
      if (platform() === 'win32') return;

      mkdirSync(fitChecksDir(), { recursive: true });
      symlinkSync(join(testDir, 'missing-target.mjs'), join(fitChecksDir(), 'broken.mjs'));

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });
  });

  describe('config-path resolution', () => {
    it('ignores `package.json#opensip-cli.configPath` for plugin declarations', () => {
      // Config lives at a non-default path; the package.json points there, but
      // implicit project discovery is intentionally root-config-only.
      mkdirSync(join(testDir, 'sub'), { recursive: true });
      writeFileSync(
        join(testDir, 'sub', 'opensip-cli.config.yml'),
        'plugins:\n  fit:\n    - "pointed-pkg"\n',
      );
      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          'opensip-cli': { configPath: 'sub/opensip-cli.config.yml' },
        }),
      );

      // Install the declared package into the plugins dir.
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'pointed-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'pointed-pkg', main: './index.js' }),
      );
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []');

      // Sanity: the default path has NO config — only the pointer path does.
      expect(existsSync(join(testDir, 'opensip-cli.config.yml'))).toBe(false);

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toEqual([]);
    });

    it('uses the default root config path', () => {
      setupPluginsConfig(['default-pkg']);
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'default-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'default-pkg', main: './index.js' }),
      );
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'package',
        namespace: 'default-pkg',
      });
    });

    it('returns undefined-equivalent (no findings) when neither config exists', () => {
      // No config anywhere → discovery falls through gracefully.
      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    });
  });

  describe('mixed discovery', () => {
    it('discovers both packages and loose user-source files in one pass', () => {
      // User source: fit/checks/loose.mjs
      mkdirSync(fitChecksDir(), { recursive: true });
      writeFileSync(join(fitChecksDir(), 'loose.mjs'), 'export const checks = []');

      // npm plugin: declared and installed
      const pluginsRoot = fitPluginsDir();
      const pkgDir = join(pluginsRoot, 'node_modules', 'pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'pkg', main: './index.js' }),
      );
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []');
      writeConfig('plugins:\n  fit:\n    - "pkg"\n');

      const result = discoverPlugins(FIT_LAYOUT, testDir);
      expect(result).toHaveLength(2);
      expect(result.find((p) => p.type === 'package')).toBeDefined();
      expect(result.find((p) => p.type === 'file')).toBeDefined();
    });
  });
});
