/**
 * Unit tests for the pure `analyzeNoLocalExit` detector (release 2.12.0, §4.7).
 */
import { describe, expect, it } from 'vitest'

import { analyzeNoLocalExit } from '../no-local-exit-or-stdout.js'

describe('analyzeNoLocalExit', () => {
  it('flags a process.exit() call', () => {
    const v = analyzeNoLocalExit('  process.exit(2)')
    expect(v).toHaveLength(1)
    expect(v[0]?.severity).toBe('error')
    expect(v[0]?.suggestion).toContain('process.exitCode')
  })

  it('flags process.exit with a computed code', () => {
    expect(analyzeNoLocalExit('process.exit(code ?? 1)')).toHaveLength(1)
  })

  it('does NOT flag the sanctioned process.exitCode assignment', () => {
    expect(analyzeNoLocalExit('process.exitCode = 2')).toHaveLength(0)
  })
})
