import { it, expect } from 'vitest'

import { widget } from './widget.js'

it('returns 42', () => {
  expect(widget()).toBe(42)
})
