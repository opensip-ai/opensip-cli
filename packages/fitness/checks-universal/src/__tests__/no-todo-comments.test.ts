import { describe, expect, it } from 'vitest'

import { analyzeTodoComments } from '../checks/no-todo-comments.js'

describe('analyzeTodoComments', () => {
  it('flags TODO in a comment', () => {
    const violations = analyzeTodoComments('// TODO: implement\nfn main() {}')
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain('TODO')
    expect(violations[0]?.line).toBe(1)
  })

  it('flags multiple markers across lines', () => {
    const src = `// TODO first
let x = 1;
// FIXME second
// HACK third`
    const violations = analyzeTodoComments(src)
    expect(violations.length).toBe(3)
  })

  it('does not flag mixed-case Todo (boundary check)', () => {
    const violations = analyzeTodoComments(`let myTodo = 1;`)
    expect(violations.length).toBe(0)
  })

  it('flags a TODO marker in a comment', () => {
    const violations = analyzeTodoComments(`// TODO: pending`)
    expect(violations.length).toBe(1)
  })
})
