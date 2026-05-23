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

  it('captures the file path relative to cwd when the file is inside cwd', () => {
    const out = `/abs/path/foo.cpp:42:10: warning: do not use 'goto' [hicpp-avoid-goto]`
    const violations = parseClangTidyOutput(out, '', 0, ['/abs/path/foo.cpp'], '/abs')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.filePath).toBe('path/foo.cpp')
  })

  it('captures the file path as absolute when the file is outside cwd', () => {
    // System headers (e.g. /usr/include/...) commonly appear in clang-tidy
    // output and must remain absolute so they aren't ambiguously rooted.
    const out = `/usr/include/stdio.h:10:1: warning: foo [check-x]`
    const violations = parseClangTidyOutput(out, '', 0, [], '/abs/project')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.filePath).toBe('/usr/include/stdio.h')
  })

  it('captures the column from group 3', () => {
    const out = `/abs/path/foo.cpp:42:17: warning: do not use 'goto' [hicpp-avoid-goto]`
    const violations = parseClangTidyOutput(out, '', 0, [], '/abs')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.column).toBe(17)
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

  it('skips lines that do not match the expected diagnostic format', () => {
    const out = 'random output\n2 warnings generated.\n'
    expect(parseClangTidyOutput(out, '', 0, [], '/x')).toEqual([])
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

  it('preserves per-file grouping across violations from multiple files', () => {
    // This is the core bug the fix addresses: without filePath capture
    // every violation was bucketed under '' and per-file grouping in the
    // dashboard / SARIF output collapsed unrelated diagnostics together.
    const out = [
      '/proj/src/foo.cpp:1:1: warning: a [check-a]',
      '/proj/src/bar.cpp:5:1: warning: b [check-b]',
      '/proj/src/foo.cpp:9:1: error: c [check-c]',
    ].join('\n')
    const violations = parseClangTidyOutput(out, '', 0, [], '/proj')
    expect(violations).toHaveLength(3)
    expect(violations[0]?.filePath).toBe('src/foo.cpp')
    expect(violations[1]?.filePath).toBe('src/bar.cpp')
    expect(violations[2]?.filePath).toBe('src/foo.cpp')
    // Verify that grouping by filePath produces two distinct buckets,
    // not one empty-string bucket as the bug originally produced.
    const filesTouched = new Set(violations.map((v) => v.filePath))
    expect(filesTouched.size).toBe(2)
  })
})
