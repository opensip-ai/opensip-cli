import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultLanguageRegistry } from '../../languages/registry.js'
import { loadAllPlugins, loadPlugin } from '../loader.js'
import type { DiscoveredPlugin } from '../types.js'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-lang-domain-'))
  defaultLanguageRegistry.clear()
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  defaultLanguageRegistry.clear()
})

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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(defaultLanguageRegistry.get('fake-rust')).toBeDefined()
    expect(defaultLanguageRegistry.forFile('demo.fakers')?.id).toBe('fake-rust')
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

    const result = await loadPlugin(plugin, 'lang')
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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.adaptersRegistered).toBe(0)
    expect(result.error).toBeUndefined()
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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.adaptersRegistered).toBe(1)
    expect(defaultLanguageRegistry.get('good')).toBeDefined()
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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(defaultLanguageRegistry.get('fake-lang-named')).toBeDefined()
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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
    expect(defaultLanguageRegistry.get('fake-lang-default')).toBeDefined()
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

    const result = await loadPlugin(plugin, 'lang')
    expect(result.error).toBeUndefined()
    expect(result.adaptersRegistered).toBe(1)
  })

  it('loadAllPlugins with lang domain aggregates totalAdapters', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'opensip-lang-base-'))
    const langDir = join(baseDir, 'lang')
    mkdirSync(langDir, { recursive: true })

    writeFileSync(
      join(langDir, 'a.mjs'),
      `export const adapters = [{
        id: 'lang-a',
        fileExtensions: ['.a'],
        parse: () => ({}),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      }];`,
    )
    writeFileSync(
      join(langDir, 'b.mjs'),
      `export const adapters = [{
        id: 'lang-b',
        fileExtensions: ['.b'],
        parse: () => ({}),
        stripStrings: (s) => s,
        stripComments: (s) => s,
      }];`,
    )

    try {
      const result = await loadAllPlugins('lang', baseDir)
      expect(result.totalAdapters).toBe(2)
      expect(defaultLanguageRegistry.get('lang-a')).toBeDefined()
      expect(defaultLanguageRegistry.get('lang-b')).toBeDefined()
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
