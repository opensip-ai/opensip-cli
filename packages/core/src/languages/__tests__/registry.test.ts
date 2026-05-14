import { describe, it, expect, beforeEach } from 'vitest'
import { LanguageRegistry } from '../registry.js'
import type { LanguageAdapter } from '../adapter.js'

const fakeRust: LanguageAdapter = {
  id: 'rust',
  fileExtensions: ['.rs'],
  parse: () => null,
  stripStrings: (s) => s,
  stripComments: (s) => s,
}

const fakePython: LanguageAdapter = {
  id: 'python',
  fileExtensions: ['.py'],
  parse: () => null,
  stripStrings: (s) => s,
  stripComments: (s) => s,
}

describe('LanguageRegistry', () => {
  let registry: LanguageRegistry

  beforeEach(() => {
    registry = new LanguageRegistry()
  })

  it('register + get round-trip by ID', () => {
    registry.register(fakeRust)
    expect(registry.get('rust')).toBe(fakeRust)
  })

  it('forFile returns the adapter that declared the extension', () => {
    registry.register(fakeRust)
    expect(registry.forFile('foo.rs')).toBe(fakeRust)
  })

  it('forFile returns undefined for unknown extensions', () => {
    registry.register(fakeRust)
    expect(registry.forFile('foo.unknown')).toBeUndefined()
  })

  it('extension comparison is case-insensitive', () => {
    const upperRust: LanguageAdapter = {
      ...fakeRust,
      fileExtensions: ['.RS'],
    }
    registry.register(upperRust)
    expect(registry.forFile('foo.rs')).toBe(upperRust)
    expect(registry.forFile('foo.RS')).toBe(upperRust)
  })

  it('registering a duplicate id is a no-op', () => {
    registry.register(fakeRust)
    const rustClone: LanguageAdapter = {
      ...fakeRust,
      fileExtensions: ['.rust'],
    }
    registry.register(rustClone)
    // Still the original adapter
    expect(registry.get('rust')).toBe(fakeRust)
    // The clone's extension was never registered
    expect(registry.forFile('foo.rust')).toBeUndefined()
    expect(registry.size).toBe(1)
  })

  it('two adapters claiming the same extension — incumbent wins', () => {
    registry.register(fakeRust)
    const altRust: LanguageAdapter = {
      id: 'alt-rust',
      fileExtensions: ['.rs'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
    }
    registry.register(altRust)
    // Extension still points to the first adapter
    expect(registry.forFile('foo.rs')).toBe(fakeRust)
    // But the alt adapter is registered by id
    expect(registry.get('alt-rust')).toBe(altRust)
  })

  it('clear() resets both maps', () => {
    registry.register(fakeRust)
    registry.register(fakePython)
    expect(registry.size).toBe(2)

    registry.clear()

    expect(registry.size).toBe(0)
    expect(registry.get('rust')).toBeUndefined()
    expect(registry.get('python')).toBeUndefined()
    expect(registry.forFile('foo.rs')).toBeUndefined()
    expect(registry.forFile('foo.py')).toBeUndefined()
  })

  it('list() returns all registered adapters', () => {
    registry.register(fakeRust)
    registry.register(fakePython)
    const all = registry.list()
    expect(all).toHaveLength(2)
    expect(all).toContain(fakeRust)
    expect(all).toContain(fakePython)
  })

  it('has() returns correct boolean', () => {
    expect(registry.has('rust')).toBe(false)
    registry.register(fakeRust)
    expect(registry.has('rust')).toBe(true)
  })

  it('forFile returns undefined for files with no extension', () => {
    registry.register(fakeRust)
    expect(registry.forFile('Makefile')).toBeUndefined()
  })
})
