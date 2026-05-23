import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { logger } from '../../lib/logger.js'
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
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    registry = new LanguageRegistry()
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('registering a duplicate id preserves the first entry (first writer wins)', () => {
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

  it('registering a duplicate id emits a structured warning', () => {
    registry.register(fakeRust)
    registry.register({ ...fakeRust, fileExtensions: ['.rust'] })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'lang.registry.duplicate',
        module: 'core:languages',
        id: 'rust',
      }),
    )
  })

  it('list() returns one entry per id even after a rejected duplicate', () => {
    registry.register(fakeRust)
    registry.register({ ...fakeRust, fileExtensions: ['.rust'] })
    expect(registry.list()).toHaveLength(1)
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

  describe('canonicalize / aliases', () => {
    const fakeCpp: LanguageAdapter = {
      id: 'cpp',
      fileExtensions: ['.cpp', '.hpp'],
      aliases: ['c', 'c++'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
    }

    const fakeRustWithAlias: LanguageAdapter = {
      ...fakeRust,
      aliases: ['rs'],
    }

    it('canonicalize returns the same id for a registered canonical id', () => {
      registry.register(fakeRust)
      expect(registry.canonicalize('rust')).toBe('rust')
    })

    it('canonicalize returns the canonical id for a registered alias', () => {
      registry.register(fakeRustWithAlias)
      expect(registry.canonicalize('rs')).toBe('rust')
    })

    it('canonicalize is case-insensitive on inputs', () => {
      registry.register(fakeCpp)
      expect(registry.canonicalize('C')).toBe('cpp')
      expect(registry.canonicalize('C++')).toBe('cpp')
      expect(registry.canonicalize('CPP')).toBe('cpp')
    })

    it('canonicalize maps the cpp adapter aliases', () => {
      registry.register(fakeCpp)
      expect(registry.canonicalize('c')).toBe('cpp')
      expect(registry.canonicalize('c++')).toBe('cpp')
      expect(registry.canonicalize('cpp')).toBe('cpp')
    })

    it('canonicalize returns undefined for unknown languages', () => {
      registry.register(fakeRust)
      expect(registry.canonicalize('nope')).toBeUndefined()
    })

    it('alias collisions across adapters keep the incumbent', () => {
      registry.register(fakeRustWithAlias)
      const challenger: LanguageAdapter = {
        id: 'r-script',
        fileExtensions: ['.r'],
        aliases: ['rs'],
        parse: () => null,
        stripStrings: (s) => s,
        stripComments: (s) => s,
      }
      registry.register(challenger)
      expect(registry.canonicalize('rs')).toBe('rust')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ evt: 'lang.registry.alias.collision' }),
      )
    })

    it('an alias colliding with a canonical id is ignored', () => {
      registry.register(fakeRust) // canonical id 'rust'
      const challenger: LanguageAdapter = {
        id: 'rusty',
        fileExtensions: ['.rusty'],
        aliases: ['rust'],
        parse: () => null,
        stripStrings: (s) => s,
        stripComments: (s) => s,
      }
      registry.register(challenger)
      // 'rust' still resolves to the canonical adapter
      expect(registry.canonicalize('rust')).toBe('rust')
      expect(registry.get('rust')).toBe(fakeRust)
    })

    it('clear() resets the alias index', () => {
      registry.register(fakeCpp)
      expect(registry.canonicalize('c')).toBe('cpp')
      registry.clear()
      expect(registry.canonicalize('c')).toBeUndefined()
    })
  })
})
