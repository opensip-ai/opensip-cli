import { describe, expect, it } from 'vitest'

import { analyzeFunctionTooLong } from '../checks/function-too-long.js'

/** A `def` whose body is `bodyLines` assignment statements. */
function pyFunction(name: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `    x${i} = ${i}`).join('\n')
  return `def ${name}():\n${body}\n`
}

describe('python-function-too-long', () => {
  it('flags a function over the line budget', () => {
    const violations = analyzeFunctionTooLong(pyFunction('big', 60), 'big.py')
    expect(violations).toHaveLength(1)
    expect(violations[0].line).toBe(1)
    expect(violations[0].message).toContain('big')
    expect(violations[0].severity).toBe('warning')
  })

  it('does not flag a short function', () => {
    expect(analyzeFunctionTooLong('def small():\n    return 1\n', 'small.py')).toEqual([])
  })

  it('counts nested functions independently (only the long one fires)', () => {
    const src = `${pyFunction('outer', 60).trimEnd()}\n    def inner():\n        return 1\n`
    const violations = analyzeFunctionTooLong(src, 'nested.py')
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toContain('outer')
  })

  it('returns [] on malformed input without throwing', () => {
    expect(() => analyzeFunctionTooLong('def (:\n', 'bad.py')).not.toThrow()
    expect(analyzeFunctionTooLong('def (:\n', 'bad.py')).toEqual([])
  })
})
