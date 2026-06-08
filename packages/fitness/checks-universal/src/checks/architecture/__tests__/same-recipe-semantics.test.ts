/**
 * Unit tests for the pure `analyzeSameRecipeSemantics` detector (release 2.13.0, §5.8).
 */
import { describe, expect, it } from 'vitest'

import { analyzeSameRecipeSemantics } from '../same-recipe-semantics.js'

describe('analyzeSameRecipeSemantics', () => {
  it('flags a raw setTimeout (a per-unit timeout reimplementation)', () => {
    const v = analyzeSameRecipeSemantics('  const t = setTimeout(() => controller.abort(), 1000)')
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('runWithTimeout')
  })

  it('does NOT flag a substrate call', () => {
    expect(analyzeSameRecipeSemantics('await scheduleUnits({ units, mode, runUnit })')).toHaveLength(0)
    expect(analyzeSameRecipeSemantics('const r = await runWithTimeout({ run, timeoutMs })')).toHaveLength(0)
  })
})
