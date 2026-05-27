import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-tools/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadAllPlugins, loadPlugin } from '../loader.js'

import type { DiscoveredPlugin } from '@opensip-tools/core'

let testDir: string
let langRegistry: LanguageRegistry
let scope: RunScope

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-lang-domain-'))
  langRegistry = new LanguageRegistry()
  scope = new RunScope({ languages: langRegistry })
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope(scope, fn)
}

describe('lang plugin domain', () => {
  it('registers adapters from a lang plugin', async () => {
    const pluginFile = join(testDir, 'lang-fake.mjs')
    writeFileSync(pluginFile, `
      export const adapters = [{
        id: 'fake-rust',
        fileExtensions: ['.fakers'],
        parse: () => ({ marker: 'fake-tree' }),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      }];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'lang-fake',
      source: 'lang-fake.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(langRegistry.get('fake-rust')).toBeDefined()
    expect(langRegistry.forFile('demo.fakers')?.id).toBe('fake-rust')
  })

  it('does not register checks when loading in lang domain', async () => {
    const pluginFile = join(testDir, 'lang-with-checks.mjs')
    // A plugin in the lang domain that exports checks should NOT register them.
    writeFileSync(pluginFile, `
      export const checks = [{ config: { id: 'wrong', slug: 'wrong' }, run: () => {} }];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'wrong-shape',
      source: 'lang-with-checks.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.checksRegistered).toBe(0)
    expect(result.adaptersRegistered).toBe(0)
  })

  it('warns when a lang plugin exports no adapters', async () => {
    const pluginFile = join(testDir, 'lang-empty.mjs')
    writeFileSync(pluginFile, '// no exports at all')

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'empty',
      source: 'lang-empty.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.adaptersRegistered).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('warns and skips when adapters export is not an array', async () => {
    const pluginFile = join(testDir, 'lang-non-array.mjs')
    writeFileSync(pluginFile, `
      export const adapters = { wrong: 'shape' };
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'lang-non-array',
      source: 'lang-non-array.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(0)
  })

  it('skips invalid adapter entries', async () => {
    const pluginFile = join(testDir, 'lang-bad-item.mjs')
    writeFileSync(pluginFile, `
      export const adapters = [
        { id: 'good', fileExtensions: ['.g'], parse: () => null, stripStrings: (s) => s, stripComments: (s) => s },
        { wrong: 'shape' },
        null,
      ];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'bad-items',
      source: 'lang-bad-item.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.adaptersRegistered).toBe(1)
    expect(langRegistry.get('good')).toBeDefined()
  })

  it('registers adapters exported as named exports (no array wrapper)', async () => {
    const pluginFile = join(testDir, 'lang-named-export.mjs')
    writeFileSync(pluginFile, `
      export const myLang = {
        id: 'fake-lang-named',
        fileExtensions: ['.fln'],
        parse: () => ({ ok: true }),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      };
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'lang-named-export',
      source: 'lang-named-export.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(langRegistry.get('fake-lang-named')).toBeDefined()
  })

  it('registers an adapter from default export', async () => {
    const pluginFile = join(testDir, 'lang-default.mjs')
    writeFileSync(pluginFile, `
      export default {
        id: 'fake-lang-default',
        fileExtensions: ['.fld'],
        parse: () => ({ ok: true }),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      };
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'lang-default',
      source: 'lang-default.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(langRegistry.get('fake-lang-default')).toBeDefined()
  })

  it('deduplicates adapters appearing in both array and named export', async () => {
    const pluginFile = join(testDir, 'lang-dedup.mjs')
    writeFileSync(pluginFile, `
      export const myLang = {
        id: 'fake-lang-dedup',
        fileExtensions: ['.fdd'],
        parse: () => ({ ok: true }),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      };
      export const adapters = [myLang];
    `)

    const plugin: DiscoveredPlugin = {
      type: 'file',
      entryPoint: pluginFile,
      namespace: 'lang-dedup',
      source: 'lang-dedup.mjs',
    }

    const result = await inScope(() => loadPlugin(plugin, 'lang'))
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
  })

  it('loadAllPlugins for the lang domain returns empty', async () => {
    // There is no project-local lang plugin discovery path —
    // language adapters ship as direct deps of @opensip-tools/cli
    // and are registered by the CLI bootstrap, not by walking a
    // user-source dir. Verify that loadAllPlugins('lang', ...)
    // discovers nothing rather than reading from a stray directory.
    const baseDir = mkdtempSync(join(tmpdir(), 'opensip-lang-base-'))
    try {
      const result = await inScope(() => loadAllPlugins('lang', baseDir))
      expect(result.totalAdapters).toBe(0)
      expect(result.plugins).toHaveLength(0)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
