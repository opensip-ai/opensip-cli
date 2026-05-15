import { describe, expect, it } from 'vitest';

import { analyzePrintStackTrace } from '../checks/no-printstacktrace.js';

describe('analyzePrintStackTrace', () => {
  it('flags e.printStackTrace()', () => {
    const out = analyzePrintStackTrace('try { foo(); } catch (Exception e) { e.printStackTrace(); }');
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('warning');
  });

  it('flags printStackTrace() with whitespace', () => {
    expect(analyzePrintStackTrace('e.printStackTrace ( )')).toHaveLength(1);
  });

  it('reports the correct line', () => {
    const out = analyzePrintStackTrace('class X {\n  void f(Exception e) {\n    e.printStackTrace();\n  }\n}');
    expect(out[0]?.line).toBe(3);
  });

  it('does not flag printStackTrace with arguments', () => {
    expect(analyzePrintStackTrace('e.printStackTrace(System.err)')).toHaveLength(0);
  });

  it('flags multiple occurrences in one file', () => {
    const src = 'a.printStackTrace();\nb.printStackTrace();';
    expect(analyzePrintStackTrace(src)).toHaveLength(2);
  });

  it('returns an empty list when no .printStackTrace() is present', () => {
    expect(analyzePrintStackTrace('class X {}')).toEqual([]);
  });
});
