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

  it('shares state with a separately-loaded copy of this module (multi-instance contract)', () => {
    // Regression test for the multi-instance bug fixed in 1.0.9. The
    // runtime frequently has TWO copies of `@opensip-tools/fitness`:
    // the CLI's bundled copy (running the recipe service) and the
    // plugin pack's resolved copy (running the check). Each copy has
    // its own module-scope state; the prior `let currentRecipeCheckConfig`
    // implementation made cross-copy state invisible. The fix moves
    // the slot onto a `Symbol.for(...)` keyed `globalThis` entry so
    // every copy reads + writes the same slot.
    //
    // Simulating "two copies" within one test: stash a value, look it
    // up under the same well-known symbol from a separate import path
    // (here: globalThis directly), and confirm the values match.
    setCurrentRecipeCheckConfig({
      'sample-check': { additionalEntries: ['cross-copy'] },
    })
    const KEY = Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')
    const slot = (globalThis as unknown as Record<symbol, unknown>)[KEY]
    expect(slot).toBeDefined()
    expect((slot as { 'sample-check': { additionalEntries: string[] } })['sample-check'].additionalEntries).toEqual(['cross-copy'])
  })
})
