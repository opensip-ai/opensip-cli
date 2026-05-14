import { describe, expect, it } from 'vitest'

import { parseClangTidyOutput } from '../checks/clang-tidy-passthrough.js'

describe('parseClangTidyOutput', () => {
  it('parses a single warning with a lint name', () => {
    const out = `/abs/path/foo.cpp:42:10: warning: do not use 'goto' [hicpp-avoid-goto]`
    const violations = parseClangTidyOutput(out, '', 0, ['/abs/path/foo.cpp'], '/abs')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.severity).toBe('warning')
    expect(violations[0]?.line).toBe(42)
    expect(violations[0]?.message).toContain('hicpp-avoid-goto')
  })

  it('parses errors with severity error', () => {
    const out = `/x/y.cpp:5:1: error: expected ';' [clang-diagnostic-error]`
    const violations = parseClangTidyOutput(out, '', 1, ['/x/y.cpp'], '/x')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.severity).toBe('error')
  })

  it('skips note: lines (notes are continuations of prior diagnostics)', () => {
    const out = [
      '/x/y.cpp:5:1: warning: prefer enum class [modernize-use-enum-class]',
      '/x/y.cpp:5:1: note: change here',
    ].join('\n')
    const violations = parseClangTidyOutput(out, '', 0, [], '/x')
    expect(violations).toHaveLength(1)
  })

  it('handles diagnostics without a lint name', () => {
    const out = `/a/b.cpp:1:1: warning: bare warning`
    const violations = parseClangTidyOutput(out, '', 0, [], '/a')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toBe('bare warning')
  })

  it('returns empty array on empty stdout', () => {
    expect(parseClangTidyOutput('', '', 0, [], '/x')).toHaveLength(0)
  })

  it('returns multiple violations for multi-line output', () => {
    const out = [
      '/x/y.cpp:1:1: warning: a [check-a]',
      '/x/y.cpp:5:1: warning: b [check-b]',
      '/x/y.cpp:9:1: error: c [check-c]',
    ].join('\n')
    const violations = parseClangTidyOutput(out, '', 0, [], '/x')
    expect(violations).toHaveLength(3)
    expect(violations[0]?.line).toBe(1)
    expect(violations[1]?.line).toBe(5)
    expect(violations[2]?.line).toBe(9)
  })
})
