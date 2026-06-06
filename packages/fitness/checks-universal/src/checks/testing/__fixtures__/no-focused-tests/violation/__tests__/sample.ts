import { describe, it, expect } from 'vitest'

describe.only('sample', () => {
  it('adds numbers', () => {
    expect(1 + 1).toBe(2)
  })
})
