/**
 * Unit tests for the pure `analyzeOneOutcomeShape` detector (release 2.12.0, §5.5).
 */
import { describe, expect, it } from 'vitest'

import { analyzeOneOutcomeShape } from '../one-outcome-shape.js'

describe('analyzeOneOutcomeShape', () => {
  it('flags the retired bare emitJson({ error }) shape', () => {
    const v = analyzeOneOutcomeShape('cli.emitJson({ error: msg })', false)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('emitJson({ error })')
    expect(v[0]?.suggestion).toContain('emitError')
  })

  it('flags a direct stdout JSON write outside the renderer', () => {
    expect(analyzeOneOutcomeShape('process.stdout.write(JSON.stringify(outcome))', false)).toHaveLength(1)
    expect(analyzeOneOutcomeShape('process.stdout.write(formatSignalJson(env))', false)).toHaveLength(1)
  })

  it('allows the stdout JSON write inside the renderer (render-outcome.ts)', () => {
    expect(analyzeOneOutcomeShape('process.stdout.write(JSON.stringify(outcome))', true)).toHaveLength(0)
  })

  it('does NOT flag the blessed emit seams or a non-error emitJson', () => {
    expect(analyzeOneOutcomeShape('cli.emitError({ message, exitCode })', false)).toHaveLength(0)
    expect(analyzeOneOutcomeShape('cli.emitJson({ count: 3, files })', false)).toHaveLength(0)
  })
})
