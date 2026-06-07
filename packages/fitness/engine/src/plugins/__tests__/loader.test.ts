import { mkdirSync, writeFileSync, rmSync , mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { enterScope, RunScope } from '@opensip-tools/core'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { fitnessTool } from '../../tool.js'
import { loadPlugin, loadAllPlugins } from '../loader.js'

import type { DiscoveredPlugin } from '@opensip-tools/core'

// Test fixtures are written to tmpdir() and dynamically imported. Node ESM
// resolution walks up from /tmp/... and can never reach the workspace's
// node_modules, so bare specifiers like '@opensip-tools/fitness' fail at
// import time. Resolve the fitness entrypoint here (the test file IS in
// fitness, so its require can resolve the package) and inject the absolute
// file URL into each fixture template.
const require = createRequire(import.meta.url)
const FITNESS_URL = pathToFileURL(require.resolve('@opensip-tools/fitness')).href

let testDir: string

beforeEach(() => {
  // The fit plugin loader registers checks/recipes into the current scope's
  // registries (`currentCheckRegistry()` / `currentRecipeRegistry()`), so each
  // test runs inside a fresh RunScope carrying fitness's contributed subscope.
  const scope = new RunScope()
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {})
  enterScope(scope)
  testDir = mkdtempSync(join(tmpdir(), 'opensip-loader-test-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('loadPlugin', () => {
  it('loads a plugin that exports an empty checks array', async () => {
    const pluginFile = join(testDir, 'empty-plugin.mjs')
    writeFileSync(pluginFile, `
      export const checks = [];
      export const metadata = { name: 'empty', version: '1.0.0' };
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'empty-plugin',
      source: 'empty-plugin.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.registered.checks).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.namespace).toBe('empty-plugin')
  })

  it('handles plugin that throws on import', async () => {
    const pluginFile = join(testDir, 'broken-plugin.mjs')
    writeFileSync(pluginFile, 'throw new Error("plugin init failed")')

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'broken',
      source: 'broken-plugin.mjs',
    }

    const result = await loadPlugin(plugin)
    // On a load failure the kernel reports an empty count map.
    expect(result.registered).toEqual({})
    expect(result.error).toContain('plugin init failed')
  })

  it('handles plugin with no exports gracefully', async () => {
    const pluginFile = join(testDir, 'no-exports.mjs')
    writeFileSync(pluginFile, '// nothing exported')

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'no-exports',
      source: 'no-exports.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.registered.checks).toBe(0)
    expect(result.registered.recipes).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('skips non-Check objects in checks array', async () => {
    const pluginFile = join(testDir, 'bad-checks.mjs')
    writeFileSync(pluginFile, `
      export const checks = [
        { notACheck: true },
        "string",
        42,
        null,
      ];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'bad-checks',
      source: 'bad-checks.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.registered.checks).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('registers Check instances exported as named exports (no array wrapper)', async () => {
    const pluginFile = join(testDir, 'named-export-checks.mjs')
    writeFileSync(pluginFile, `
      import { defineCheck } from '${FITNESS_URL}';

      export const myFirstCheck = defineCheck({
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'my-first',
        description: 'First check via named export',
        scope: { languages: ['rust'], concerns: [] },
        tags: ['quality'],
        analyze: () => [],
      });

      export const mySecondCheck = defineCheck({
        id: '22222222-2222-2222-2222-222222222222',
        slug: 'my-second',
        description: 'Second check via named export',
        scope: { languages: ['rust'], concerns: [] },
        tags: ['quality'],
        analyze: () => [],
      });

      // Non-check named exports are ignored
      export const helper = (s) => s;
      export const VERSION = '1.0.0';
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'named-export-checks',
      source: 'named-export-checks.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.error).toBeUndefined()
    expect(result.registered.checks).toBe(2)
  })

  it('registers a Check from default export', async () => {
    const pluginFile = join(testDir, 'default-export-check.mjs')
    writeFileSync(pluginFile, `
      import { defineCheck } from '${FITNESS_URL}';

      export default defineCheck({
        id: '33333333-3333-3333-3333-333333333333',
        slug: 'default-check',
        description: 'Single check via default export',
        scope: { languages: ['rust'], concerns: [] },
        tags: ['quality'],
        analyze: () => [],
      });
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'default-export-check',
      source: 'default-export-check.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.error).toBeUndefined()
    expect(result.registered.checks).toBe(1)
  })

  it('warns and skips when checks export is not an array', async () => {
    const pluginFile = join(testDir, 'non-array-checks.mjs')
    writeFileSync(pluginFile, `
      export const checks = { not: 'an-array' };
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'non-array-checks',
      source: 'non-array-checks.mjs',
    }

    const result = await loadPlugin(plugin)
    // Loader warns and continues — no error, zero registrations.
    expect(result.error).toBeUndefined()
    expect(result.registered.checks).toBe(0)
  })

  it('registers recipes alongside checks', async () => {
    const pluginFile = join(testDir, 'with-recipes.mjs')
    writeFileSync(pluginFile, `
      export const recipes = [
        {
          id: 'URCP_plugin-test',
          name: 'plugin-recipe-test',
          displayName: 'Plugin Test',
          description: 'recipe contributed by a plugin',
          checks: { type: 'all', exclude: [] },
          execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30000 },
          reporting: { format: 'table', verbose: false },
        },
      ];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'plugin-recipes',
      source: 'with-recipes.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.error).toBeUndefined()
    expect(result.registered.recipes).toBeGreaterThanOrEqual(1)
  })

  it('warns on malformed recipe entries (missing id/name) without failing', async () => {
    const pluginFile = join(testDir, 'malformed-recipes.mjs')
    writeFileSync(pluginFile, `
      export const recipes = [
        { malformed: true },
        null,
      ];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'malformed-recipes',
      source: 'malformed-recipes.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.error).toBeUndefined()
    expect(result.registered.recipes).toBe(0)
  })

  it('deduplicates checks appearing in both array and named exports', async () => {
    const pluginFile = join(testDir, 'dedup-checks.mjs')
    writeFileSync(pluginFile, `
      import { defineCheck } from '${FITNESS_URL}';

      export const sameCheck = defineCheck({
        id: '44444444-4444-4444-4444-444444444444',
        slug: 'same',
        description: 'Same check exported two ways',
        scope: { languages: ['rust'], concerns: [] },
        tags: ['quality'],
        analyze: () => [],
      });

      export const checks = [sameCheck];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'dedup-checks',
      source: 'dedup-checks.mjs',
    }

    const result = await loadPlugin(plugin)
    expect(result.error).toBeUndefined()
    expect(result.registered.checks).toBe(1)
  })
})

describe('loadAllPlugins', () => {
  it('returns empty result when no plugins found', async () => {
    const result = await loadAllPlugins('fit', join(testDir, 'nonexistent'))
    expect(result.plugins).toEqual([])
    expect(result.totals).toEqual({})
    expect(result.errors).toEqual([])
  })

  it('aggregates results from multiple plugins', async () => {
    // Project layout: opensip-tools/fit/checks/<file>.mjs
    const checksDir = join(testDir, 'opensip-tools', 'fit', 'checks')
    mkdirSync(checksDir, { recursive: true })
    writeFileSync(join(checksDir, 'a.mjs'), 'export const checks = []')
    writeFileSync(join(checksDir, 'b.mjs'), 'export const checks = []')

    const result = await loadAllPlugins('fit', testDir)
    expect(result.plugins).toHaveLength(2)
  })

  it('collects errors from failed plugins', async () => {
    const checksDir = join(testDir, 'opensip-tools', 'fit', 'checks')
    mkdirSync(checksDir, { recursive: true })
    writeFileSync(join(checksDir, 'ok.mjs'), 'export const checks = []')
    writeFileSync(join(checksDir, 'bad.mjs'), 'throw new Error("boom")')

    const result = await loadAllPlugins('fit', testDir)
    expect(result.plugins).toHaveLength(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('boom')
  })
})
