import { mkdirSync, writeFileSync, rmSync, symlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { discoverPlugins } from '../discover.js'

let testDir: string

beforeEach(() => {
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- mkdtempSync creates a private 700 dir under tmpdir; safe for test fixtures
  testDir = mkdtempSync(join(tmpdir(), 'opensip-plugins-test-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

/**
 * Helpers to build the v3 layout in the test tmpdir:
 *
 *   <testDir>/opensip-tools/<tool>/<kind>/<file>.mjs
 *   <testDir>/opensip-tools/<tool>/<kind>/<file>.js
 *   <testDir>/opensip-tools/.runtime/plugins/<domain>/...
 *   <testDir>/opensip-tools.config.yml  (declares plugins.<domain>)
 */

function fitChecksDir(): string {
  return join(testDir, 'opensip-tools', 'fit', 'checks')
}
function fitRecipesDir(): string {
  return join(testDir, 'opensip-tools', 'fit', 'recipes')
}
function simScenariosDir(): string {
  return join(testDir, 'opensip-tools', 'sim', 'scenarios')
}
function fitPluginsDir(): string {
  return join(testDir, 'opensip-tools', '.runtime', 'plugins', 'fit')
}
function writeConfig(yaml: string): void {
  writeFileSync(join(testDir, 'opensip-tools.config.yml'), yaml)
}

/** Build a `plugins.fit:` config block with the given declared deps. */
function setupPluginsConfig(deps: string[]): void {
  const list = deps.map(d => `    - "${d}"`).join('\n')
  writeConfig(`plugins:\n  fit:\n${list}\n`)
}

describe('discoverPlugins (v3 layout)', () => {
  it('returns empty array when projectDir is undefined', () => {
    expect(discoverPlugins('fit')).toEqual([])
  })

  it('returns empty array when no opensip-tools/ directory exists', () => {
    expect(discoverPlugins('fit', testDir)).toEqual([])
  })

  it('returns empty array for `lang` and `asm` (no v3 subdir model)', () => {
    mkdirSync(join(testDir, 'opensip-tools', 'lang'), { recursive: true })
    mkdirSync(join(testDir, 'opensip-tools', 'asm'), { recursive: true })
    expect(discoverPlugins('lang', testDir)).toEqual([])
    expect(discoverPlugins('asm', testDir)).toEqual([])
  })

  describe('user-source files (no config opt-in needed)', () => {
    it('discovers .mjs files in opensip-tools/fit/checks/', () => {
      mkdirSync(fitChecksDir(), { recursive: true })
      writeFileSync(join(fitChecksDir(), 'my-check.mjs'), 'export const checks = []')

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'file',
        source: 'my-check.mjs',
      })
      expect(result[0]?.namespace).toContain('my-check')
    })

    it('discovers .js files in opensip-tools/fit/checks/', () => {
      mkdirSync(fitChecksDir(), { recursive: true })
      writeFileSync(join(fitChecksDir(), 'plugin.js'), 'export const checks = []')

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]?.source).toBe('plugin.js')
    })

    it('discovers files in BOTH opensip-tools/fit/checks/ and opensip-tools/fit/recipes/', () => {
      mkdirSync(fitChecksDir(), { recursive: true })
      mkdirSync(fitRecipesDir(), { recursive: true })
      writeFileSync(join(fitChecksDir(), 'my-check.mjs'), 'export const checks = []')
      writeFileSync(join(fitRecipesDir(), 'my-recipe.mjs'), 'export const recipes = []')

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(2)
      const sources = result.map(p => p.source).sort()
      expect(sources).toEqual(['my-check.mjs', 'my-recipe.mjs'])
    })

    it('namespaces sim files under sim/scenarios distinctly from sim/recipes', () => {
      mkdirSync(simScenariosDir(), { recursive: true })
      writeFileSync(join(simScenariosDir(), 'load.mjs'), 'export const scenarios = []')

      const result = discoverPlugins('sim', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]?.namespace).toContain('sim/scenarios/load')
    })

    it('ignores non-js files', () => {
      mkdirSync(fitChecksDir(), { recursive: true })
      writeFileSync(join(fitChecksDir(), 'readme.txt'), 'not a plugin')
      writeFileSync(join(fitChecksDir(), 'data.json'), '{}')

      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('ignores subdirectories when scanning loose files', () => {
      mkdirSync(join(fitChecksDir(), 'subdir'), { recursive: true })
      expect(discoverPlugins('fit', testDir)).toEqual([])
    })
  })

  describe('npm-installed plugins (config opt-in required)', () => {
    it('does NOT auto-load packages when plugins.fit is not declared', () => {
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', 'silent-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'silent-pkg', main: './index.js' }))
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []')

      // Config is absent → no opt-in → package not loaded
      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('discovers packages listed in plugins.fit when installed', () => {
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', 'my-plugin')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'my-plugin', main: './index.js' }))
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []')

      setupPluginsConfig(['my-plugin'])

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'package',
        namespace: 'my-plugin',
        source: 'my-plugin',
      })
    })

    it('discovers scoped packages declared in plugins.fit', () => {
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', '@scope', 'checks')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@scope/checks',
        main: './dist/index.js',
      }))
      mkdirSync(join(pkgDir, 'dist'))
      writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export const checks = []')

      setupPluginsConfig(['@scope/checks'])

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: 'package',
        namespace: '@scope/checks',
      })
    })

    it('skips packages that are listed but not installed', () => {
      setupPluginsConfig(['ghost-package'])
      // No node_modules/ghost-package/ exists
      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('skips packages without an entry point', () => {
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', 'broken')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'broken',
        main: './nonexistent.js',
      }))
      setupPluginsConfig(['broken'])

      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('uses exports["."] when available', () => {
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', 'exports-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'exports-pkg',
        exports: { '.': './lib/main.js' },
      }))
      mkdirSync(join(pkgDir, 'lib'))
      writeFileSync(join(pkgDir, 'lib', 'main.js'), 'export const checks = []')

      setupPluginsConfig(['exports-pkg'])

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(1)
      expect(result[0]?.entryPoint).toContain('lib/main.js')
    })
  })

  describe('security: path traversal and symlink containment', () => {
    it('rejects plugin names containing .. (would traverse out of node_modules)', () => {
      // The plugin list comes from opensip-tools.config.yml. A malicious
      // (or careless) entry like "../escapee" would, without the
      // containment check, resolve relative to node_modules and pull in
      // arbitrary code.
      const pluginsRoot = fitPluginsDir()
      mkdirSync(join(pluginsRoot, 'node_modules'), { recursive: true })
      const escapee = join(pluginsRoot, 'node_modules', '..', 'escapee')
      mkdirSync(escapee, { recursive: true })
      writeFileSync(join(escapee, 'package.json'), JSON.stringify({ name: 'escapee', main: './index.js' }))
      writeFileSync(join(escapee, 'index.js'), 'export const checks = []')

      setupPluginsConfig(['../escapee'])

      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('rejects absolute-path plugin names', () => {
      mkdirSync(fitPluginsDir(), { recursive: true })
      setupPluginsConfig(['/etc/passwd'])
      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('rejects loose-file plugins that are symlinks pointing outside the source dir', () => {
      // Skip on Windows where symlink creation needs elevated privileges
      // in CI and isn't part of the threat model.
      if (platform() === 'win32') return

      mkdirSync(fitChecksDir(), { recursive: true })

      const outsideTarget = join(testDir, 'evil-target.mjs')
      writeFileSync(outsideTarget, 'export const checks = []')

      const symlinkPath = join(fitChecksDir(), 'looks-legit.mjs')
      symlinkSync(outsideTarget, symlinkPath)

      expect(discoverPlugins('fit', testDir)).toEqual([])
    })

    it('accepts symlinks that resolve INSIDE the source dir (pnpm-style)', () => {
      if (platform() === 'win32') return

      mkdirSync(fitChecksDir(), { recursive: true })

      const realFile = join(fitChecksDir(), 'real-plugin.mjs')
      writeFileSync(realFile, 'export const checks = []')

      const symlinkPath = join(fitChecksDir(), 'aliased.mjs')
      symlinkSync(realFile, symlinkPath)

      const result = discoverPlugins('fit', testDir)
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.every(p => p.type === 'file')).toBe(true)
    })
  })

  describe('mixed discovery', () => {
    it('discovers both packages and loose user-source files in one pass', () => {
      // User source: fit/checks/loose.mjs
      mkdirSync(fitChecksDir(), { recursive: true })
      writeFileSync(join(fitChecksDir(), 'loose.mjs'), 'export const checks = []')

      // npm plugin: declared and installed
      const pluginsRoot = fitPluginsDir()
      const pkgDir = join(pluginsRoot, 'node_modules', 'pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', main: './index.js' }))
      writeFileSync(join(pkgDir, 'index.js'), 'export const checks = []')
      writeConfig('plugins:\n  fit:\n    - "pkg"\n')

      const result = discoverPlugins('fit', testDir)
      expect(result).toHaveLength(2)
      expect(result.find(p => p.type === 'package')).toBeDefined()
      expect(result.find(p => p.type === 'file')).toBeDefined()
    })
  })
})
