import { describe, expect, it } from 'vitest';

import { analyzePrintStackTrace } from '../checks/no-printstacktrace.js';

/**
 * Pure-analyzer unit tests. The framework's `strip-strings-and-comments`
 * content filter is applied BEFORE `analyze` is called, so this file's
 * fixtures are deliberately comment-free and string-free — they exercise
 * the analyzer directly, not the filter pipeline. End-to-end coverage of
 * the comment/string false-positive handling lives in `run.test.ts`,
 * which drives the full `noPrintStackTrace.run()` pipeline.
 */
describe('analyzePrintStackTrace', () => {
  it('flags e.printStackTrace()', () => {
    const violations = analyzePrintStackTrace('e.printStackTrace();');
    expect(violations.length).toBe(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.severity).toBe('warning');
    expect(violations[0]?.message).toContain('logging framework');
  });

  it('reports correct line numbers for multiple matches', () => {
    const src = [
      'class A {',
      '  void m(Throwable e) {',
      '    e.printStackTrace();',
      '    int x = 1;',
      '    e.printStackTrace();',
      '  }',
      '}',
    ].join('\n');
    const violations = analyzePrintStackTrace(src);
    expect(violations.length).toBe(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(5);
  });

  it('flags multiple bare calls in a flat fixture', () => {
    const src = 'a.printStackTrace();\nb.printStackTrace();';
    expect(analyzePrintStackTrace(src)).toHaveLength(2);
  });

  it('flags calls with whitespace inside the parens', () => {
    const violations = analyzePrintStackTrace('e.printStackTrace( );');
    expect(violations.length).toBe(1);
  });

  it('does not flag printStackTrace with arguments (different signature)', () => {
    // printStackTrace(PrintStream) is a legitimate call — only the
    // no-arg variant goes to System.err implicitly.
    const violations = analyzePrintStackTrace('e.printStackTrace(System.out);');
    expect(violations.length).toBe(0);
  });

  it('returns an empty list when no .printStackTrace() is present', () => {
    expect(analyzePrintStackTrace('class X {}')).toEqual([]);
  });
});
