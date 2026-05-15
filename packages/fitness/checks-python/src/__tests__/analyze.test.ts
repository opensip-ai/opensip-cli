import { describe, expect, it } from 'vitest';

import { analyzeBareExcept } from '../checks/no-bare-except.js';

describe('analyzeBareExcept', () => {
  it('flags a bare except:', () => {
    const out = analyzeBareExcept('try:\n    foo()\nexcept:\n    pass\n');
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('warning');
    expect(out[0]?.line).toBe(3);
  });

  it('flags a bare except : with whitespace before the colon', () => {
    const out = analyzeBareExcept('try:\n    foo()\nexcept :\n    pass\n');
    expect(out).toHaveLength(1);
  });

  it('does not flag a typed except', () => {
    expect(analyzeBareExcept('try:\n    foo()\nexcept Exception:\n    pass\n')).toHaveLength(0);
  });

  it('does not flag except with parentheses (multi-type)', () => {
    expect(analyzeBareExcept('try:\n    foo()\nexcept (KeyError, ValueError):\n    pass\n')).toHaveLength(0);
  });

  it('flags multiple bare excepts in the same file', () => {
    const src = 'try:\n  a()\nexcept:\n  pass\ntry:\n  b()\nexcept:\n  pass\n';
    const out = analyzeBareExcept(src);
    expect(out).toHaveLength(2);
  });

  it('returns an empty list for code without except clauses', () => {
    expect(analyzeBareExcept('def foo(): return 1\n')).toEqual([]);
  });

  it('respects leading indentation (nested try)', () => {
    const src = 'def f():\n    try:\n        a()\n    except:\n        pass\n';
    const out = analyzeBareExcept(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.line).toBe(4);
  });
});
