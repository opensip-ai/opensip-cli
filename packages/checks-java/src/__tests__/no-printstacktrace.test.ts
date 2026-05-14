import { stripComments, stripStrings } from '@opensip-tools/lang-java/strip'
import { describe, expect, it } from 'vitest'

import { analyzePrintStackTrace } from '../checks/no-printstacktrace.js'

describe('analyzePrintStackTrace', () => {
  it('flags e.printStackTrace()', () => {
    const violations = analyzePrintStackTrace('e.printStackTrace();')
    expect(violations.length).toBe(1)
    expect(violations[0]?.line).toBe(1)
    expect(violations[0]?.message).toContain('logging framework')
  })

  it('does not flag the same literal text inside a string after stripping', () => {
    // The content filter (strip-strings-and-comments) is applied by the
    // framework before calling analyze. Simulate that here.
    const src = 'String s = "e.printStackTrace()";'
    const filtered = stripStrings(src)
    const violations = analyzePrintStackTrace(filtered)
    expect(violations.length).toBe(0)
  })

  it('does not flag occurrences inside comments after stripping', () => {
    const src = '// see e.printStackTrace() for example\nint x = 1;'
    const filtered = stripComments(src)
    const violations = analyzePrintStackTrace(filtered)
    expect(violations.length).toBe(0)
  })

  it('reports correct line numbers for multiple matches', () => {
    const src = [
      'class A {',
      '  void m(Throwable e) {',
      '    e.printStackTrace();',
      '    int x = 1;',
      '    e.printStackTrace();',
      '  }',
      '}',
    ].join('\n')
    const violations = analyzePrintStackTrace(src)
    expect(violations.length).toBe(2)
    expect(violations[0]?.line).toBe(3)
    expect(violations[1]?.line).toBe(5)
  })

  it('flags calls with whitespace inside the parens', () => {
    const violations = analyzePrintStackTrace('e.printStackTrace( );')
    expect(violations.length).toBe(1)
  })

  it('does not flag printStackTrace with arguments (different signature)', () => {
    // printStackTrace(PrintStream) is a legitimate call — only the
    // no-arg variant goes to System.err implicitly.
    const violations = analyzePrintStackTrace(
      'e.printStackTrace(System.out);',
    )
    expect(violations.length).toBe(0)
  })
})
