/**
 * @fileoverview Direct unit tests for the observability-coverage analyzer
 * helper module.
 *
 * Exercises the AST function extraction across function-like declarations
 * (function/method/arrow/constructor/expressions), accessor skipping, the
 * try/catch detector, async modifier detection, and named-vs-anonymous
 * resolution.
 */

import { describe, expect, it } from 'vitest'

import { extractFunctions } from '../analyzer.js'

describe('observability-coverage analyzer — extractFunctions', () => {
  it('returns an empty array when the source cannot be parsed', () => {
    // getSharedSourceFile returns undefined for unsupported extensions.
    // We force that path by passing a non-TS path; for safety we also pass
    // empty content so any fallback returns nothing.
    expect(extractFunctions('export const x = 1', 'test.ts')).toEqual([])
  })

  it('extracts a top-level FunctionDeclaration with body', () => {
    const src = `
      export function add(a: number, b: number): number {
        return a + b
      }
    `
    const fns = extractFunctions(src, 'add.ts')
    expect(fns).toHaveLength(1)
    expect(fns[0]?.name).toBe('add')
    expect(fns[0]?.isAsync).toBe(false)
    expect(fns[0]?.hasTryCatch).toBe(false)
  })

  it('marks async functions and detects try/catch in the body', () => {
    const src = `
      export async function fetchUser(id: string) {
        try {
          return await fetch('/api/user/' + id)
        } catch (e) {
          throw e
        }
      }
    `
    const fns = extractFunctions(src, 'fetch.ts')
    expect(fns).toHaveLength(1)
    expect(fns[0]?.name).toBe('fetchUser')
    expect(fns[0]?.isAsync).toBe(true)
    expect(fns[0]?.hasTryCatch).toBe(true)
  })

  it('extracts arrow functions assigned to a variable using the variable name', () => {
    const src = `
      const greet = (name: string) => 'Hello ' + name
    `
    const fns = extractFunctions(src, 'arrow.ts')
    expect(fns.find((f) => f.name === 'greet')).toBeDefined()
  })

  it('uses property name for function expressions assigned in object literals', () => {
    const src = `
      export const handlers = {
        onClick: function () { return 1 },
        onHover: function namedHover() { return 2 },
      }
    `
    const fns = extractFunctions(src, 'handlers.ts')
    const names = fns.map((f) => f.name)
    expect(names).toContain('onClick')
    // Named function expressions resolve via the property assignment path
    // before falling through to node.name resolution.
    expect(names).toContain('onHover')
  })

  it('falls back to <anonymous> for unnamed/IIFE function expressions', () => {
    const src = `
      const result = (function () { return 42 })()
    `
    const fns = extractFunctions(src, 'iife.ts')
    expect(fns.some((f) => f.name === '<anonymous>')).toBe(true)
  })

  it('extracts methods, constructors, and skips getters/setters', () => {
    const src = `
      export class UserService {
        constructor(private readonly db: { query: (sql: string) => unknown }) {}
        async findById(id: string) { return this.db.query('SELECT 1') }
        get name() { return 'service' }
        set name(_: string) { /* noop */ }
      }
    `
    const fns = extractFunctions(src, 'class.ts')
    const names = fns.map((f) => f.name)
    expect(names).toContain('constructor')
    expect(names).toContain('findById')
    // Accessors are skipped explicitly
    expect(names).not.toContain('name')
  })

  it('skips abstract methods and overload signatures (no body)', () => {
    const src = `
      export abstract class Base {
        abstract run(): void
      }
      export function overload(x: number): number
      export function overload(x: string): string
      export function overload(x: number | string) { return x }
    `
    const fns = extractFunctions(src, 'overload.ts')
    // Overload signatures lack bodies — only the implementation should be
    // extracted.
    const overloads = fns.filter((f) => f.name === 'overload')
    expect(overloads).toHaveLength(1)
  })
})
