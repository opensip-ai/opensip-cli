/**
 * @fileoverview Regression tests for `context-mutation-check` FP fix.
 *
 * The 1.0.7 release added detection for locally-declared `ctx` /
 * `context` variables — when the file declares them via `const`/`let`/
 * `var`, subsequent `.X =` mutations are object-construction patterns
 * (`const ctx = {}; ctx.x = ...`), NOT mutations of a shared request
 * context. This test pins the FP that previously fired.
 */

import { describe, expect, it } from 'vitest'

import { analyzeContextMutation } from '../context-safety.js'

function analyze(src: string): readonly { line: number }[] {
  return analyzeContextMutation(src, 'test.ts')
}

describe('context-mutation-check — FP regression suite (1.0.7)', () => {
  it('does NOT flag mutations on a locally-declared const ctx object', () => {
    const src = `
      function buildContext() {
        const ctx: { foo?: string; bar?: number } = {}
        ctx.foo = 'value'
        ctx.bar = 42
        return ctx
      }
    `
    expect(analyze(src)).toHaveLength(0)
  })

  it('does NOT flag mutations on a locally-declared let context object', () => {
    const src = `
      function build() {
        let context: Record<string, unknown> = {}
        context.id = 'abc'
        return context
      }
    `
    expect(analyze(src)).toHaveLength(0)
  })

  it('STILL flags mutations on req.context (passed request)', () => {
    const src = `
      function middleware(req: Request) {
        req.context.user = 'X'
      }
    `
    expect(analyze(src).length).toBeGreaterThanOrEqual(1)
  })

  it('STILL flags mutations on request.context (passed request)', () => {
    const src = `
      function middleware(request: Request) {
        request.context.user = 'X'
      }
    `
    expect(analyze(src).length).toBeGreaterThanOrEqual(1)
  })
})
