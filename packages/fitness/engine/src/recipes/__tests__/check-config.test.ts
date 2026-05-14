/**
 * @fileoverview Tests for the per-check recipe-config helper.
 */

import { describe, it, expect, afterEach } from 'vitest'

import {
  getCheckConfig,
  setCurrentRecipeCheckConfig,
  clearCurrentRecipeCheckConfig,
} from '../check-config.js'

interface SampleConfig extends Record<string, unknown> {
  additionalEntries?: string[]
}

describe('getCheckConfig', () => {
  afterEach(() => {
    clearCurrentRecipeCheckConfig()
  })

  it('returns an empty object when no recipe config is set', () => {
    const cfg = getCheckConfig<SampleConfig>('any-slug')
    expect(cfg).toEqual({})
  })

  it('returns an empty object for a slug not present in the recipe config', () => {
    setCurrentRecipeCheckConfig({
      'other-check': { additionalEntries: ['x'] },
    })
    const cfg = getCheckConfig<SampleConfig>('missing')
    expect(cfg).toEqual({})
  })

  it('returns the recipe-config slice for the matching slug', () => {
    setCurrentRecipeCheckConfig({
      'sample-check': { additionalEntries: ['a', 'b'] },
    })
    const cfg = getCheckConfig<SampleConfig>('sample-check')
    expect(cfg.additionalEntries).toEqual(['a', 'b'])
  })

  it('returns an empty object after clearCurrentRecipeCheckConfig is called', () => {
    setCurrentRecipeCheckConfig({
      'sample-check': { additionalEntries: ['a', 'b'] },
    })
    clearCurrentRecipeCheckConfig()
    const cfg = getCheckConfig<SampleConfig>('sample-check')
    expect(cfg).toEqual({})
  })
})
