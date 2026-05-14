import { describe, it, expect } from 'vitest'
import { CheckRegistry } from '../../framework/registry.js'
import { resolveChecks } from '../check-resolution.js'
import type { Check } from '../../framework/check-types.js'
import type { CheckSelector } from '../types.js'

function makeCheck(slug: string, tags: string[] = ['quality'], opts?: { disabled?: boolean }): Check {
  return {
    config: {
      id: `id-${slug}`,
      slug,
      tags,
      description: `Check: ${slug}`,
      analysisMode: 'analyze',
      scope: { include: [], exclude: [], description: '' },
      itemType: 'files',
      disabled: opts?.disabled,
      execute: async () => ({ findings: [], passed: true }),
    },
    run: async () => ({ findings: [], passed: true }),
    getScope: () => ({ include: [], exclude: [], description: '' }),
    getMatcher: () => ({ matches: () => true }),
  } as unknown as Check
}

function createRegistry(...checks: Check[]): CheckRegistry {
  const reg = new CheckRegistry()
  for (const check of checks) {
    reg.register(check)
  }
  return reg
}

function createNamespacedRegistry(namespace: string, ...checks: Check[]): CheckRegistry {
  const reg = new CheckRegistry()
  for (const check of checks) {
    reg.register(check, namespace)
  }
  return reg
}

describe('resolveChecks', () => {
  describe('tags selector', () => {
    it('resolves checks matching a single tag', () => {
      const reg = createRegistry(
        makeCheck('a', ['security']),
        makeCheck('b', ['quality']),
        makeCheck('c', ['security', 'quality']),
      )
      const selector: CheckSelector = { type: 'tags', include: ['security'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(2)
      expect(result).toContain('a')
      expect(result).toContain('c')
    })

    it('resolves checks matching any include tag', () => {
      const reg = createRegistry(
        makeCheck('a', ['security']),
        makeCheck('b', ['performance']),
        makeCheck('c', ['quality']),
      )
      const selector: CheckSelector = { type: 'tags', include: ['security', 'performance'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(2)
      expect(result).toContain('a')
      expect(result).toContain('b')
    })

    it('excludes checks matching exclude tags', () => {
      const reg = createRegistry(
        makeCheck('a', ['security', 'backend']),
        makeCheck('b', ['security', 'frontend']),
      )
      const selector: CheckSelector = { type: 'tags', include: ['security'], exclude: ['frontend'] }
      const result = resolveChecks(selector, reg)
      expect(result).toEqual(['a'])
    })

    it('returns empty array when no tags match', () => {
      const reg = createRegistry(makeCheck('a', ['quality']))
      const selector: CheckSelector = { type: 'tags', include: ['nonexistent'] }
      expect(resolveChecks(selector, reg)).toEqual([])
    })
  })

  describe('explicit selector', () => {
    it('resolves by bare slug', () => {
      const reg = createRegistry(makeCheck('no-eval'), makeCheck('no-console'))
      const selector: CheckSelector = { type: 'explicit', checkIds: ['no-eval'] }
      expect(resolveChecks(selector, reg)).toEqual(['no-eval'])
    })

    it('resolves bare slug to namespaced check', () => {
      const reg = createNamespacedRegistry('builtin',
        makeCheck('no-eval'),
        makeCheck('no-console'),
      )
      const selector: CheckSelector = { type: 'explicit', checkIds: ['no-eval'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe('builtin:no-eval')
    })

    it('resolves by exact namespaced slug', () => {
      const reg = createNamespacedRegistry('builtin', makeCheck('no-eval'))
      const selector: CheckSelector = { type: 'explicit', checkIds: ['builtin:no-eval'] }
      expect(resolveChecks(selector, reg)).toEqual(['builtin:no-eval'])
    })

    it('filters out unknown slugs', () => {
      const reg = createRegistry(makeCheck('exists'))
      const selector: CheckSelector = { type: 'explicit', checkIds: ['exists', 'nope'] }
      expect(resolveChecks(selector, reg)).toEqual(['exists'])
    })
  })

  describe('pattern selector', () => {
    it('matches tag/slug patterns like security/*', () => {
      const reg = createRegistry(
        makeCheck('no-eval', ['security']),
        makeCheck('null-safety', ['quality']),
        makeCheck('sql-injection', ['security']),
      )
      const selector: CheckSelector = { type: 'pattern', include: ['security/*'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(2)
      expect(result).toContain('no-eval')
      expect(result).toContain('sql-injection')
    })

    it('matches bare slug patterns', () => {
      const reg = createRegistry(
        makeCheck('no-eval'), makeCheck('no-console'), makeCheck('null-safety'),
      )
      const selector: CheckSelector = { type: 'pattern', include: ['no-*'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(2)
    })

    it('excludes patterns correctly', () => {
      const reg = createRegistry(
        makeCheck('no-eval', ['security']),
        makeCheck('no-console', ['quality']),
        makeCheck('no-any', ['quality']),
      )
      const selector: CheckSelector = { type: 'pattern', include: ['no-*'], exclude: ['quality/*'] }
      const result = resolveChecks(selector, reg)
      expect(result).toEqual(['no-eval'])
    })

    it('matches namespaced slugs via tag patterns', () => {
      const reg = createNamespacedRegistry('builtin',
        makeCheck('no-eval', ['security']),
        makeCheck('null-safety', ['quality']),
      )
      const selector: CheckSelector = { type: 'pattern', include: ['security/*'] }
      const result = resolveChecks(selector, reg)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe('builtin:no-eval')
    })
  })

  describe('all selector', () => {
    it('returns all checks', () => {
      const reg = createRegistry(makeCheck('a'), makeCheck('b'), makeCheck('c'))
      const selector: CheckSelector = { type: 'all' }
      expect(resolveChecks(selector, reg)).toHaveLength(3)
    })

    it('excludes by pattern', () => {
      const reg = createRegistry(
        makeCheck('no-eval', ['security']),
        makeCheck('null-safety', ['quality']),
      )
      const selector: CheckSelector = { type: 'all', exclude: ['security/*'] }
      const result = resolveChecks(selector, reg)
      expect(result).toEqual(['null-safety'])
    })
  })
})
