import { describe, expect, it } from 'vitest';

import { analyzeDbgMacro } from '../checks/no-dbg-macro.js';

describe('analyzeDbgMacro', () => {
  it('flags dbg!() with parentheses', () => {
    const violations = analyzeDbgMacro('dbg!(x);');
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain('dbg!()');
    expect(violations[0]?.severity).toBe('warning');
    expect(violations[0]?.line).toBe(1);
  });

  it('flags dbg![] with brackets', () => {
    const violations = analyzeDbgMacro('dbg![x, y];');
    expect(violations.length).toBe(1);
  });

  it('flags dbg!{} with braces', () => {
    const violations = analyzeDbgMacro('dbg!{x};');
    expect(violations.length).toBe(1);
  });

  it('does not flag != operator', () => {
    expect(analyzeDbgMacro('if dbg != foo { }')).toHaveLength(0);
    expect(analyzeDbgMacro('a != b')).toHaveLength(0);
  });

  it('does not flag identifiers that contain dbg', () => {
    expect(analyzeDbgMacro('xdbg!(x)')).toHaveLength(0);
    expect(analyzeDbgMacro('let dbgger = 1;')).toHaveLength(0);
    expect(analyzeDbgMacro('mydbg!(x)')).toHaveLength(0);
  });

  it('does not flag function-call dbg(x) (no bang)', () => {
    expect(analyzeDbgMacro('dbg(x)')).toHaveLength(0);
  });

  it('reports correct line numbers across multiple matches', () => {
    const src = `fn main() {
    let x = 1;
    dbg!(x);
    let y = 2;
    dbg!(x, y);
}`;
    const violations = analyzeDbgMacro(src);
    expect(violations.length).toBe(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(5);
  });

  it('flags multiple occurrences on a single line', () => {
    const violations = analyzeDbgMacro('dbg!(a); dbg!(b);');
    expect(violations.length).toBe(2);
  });

  it('returns an empty list for content without dbg!', () => {
    expect(analyzeDbgMacro('fn main() {}')).toEqual([]);
  });

  it('handles whitespace between dbg! and delimiter', () => {
    expect(analyzeDbgMacro('dbg! (x);')).toHaveLength(1);
  });
});
