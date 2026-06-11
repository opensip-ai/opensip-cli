import { describe, expect, it } from 'vitest';

import { analyzeBareExcept } from '../checks/no-bare-except.js';

describe('analyzeBareExcept', () => {
  it('flags `except:` on its own line', () => {
    const src = `try:
    risky()
except:
    pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(1);
    expect(violations[0]?.message).toContain('Bare');
    expect(violations[0]?.severity).toBe('warning');
    expect(violations[0]?.line).toBe(3);
  });

  it('returns an empty list for code without except clauses', () => {
    expect(analyzeBareExcept('def foo(): return 1\n')).toEqual([]);
  });

  it('does not flag `except Exception:`', () => {
    const src = `try:
    risky()
except Exception:
    pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(0);
  });

  it('does not flag `except (TypeError, ValueError):`', () => {
    const src = `try:
    risky()
except (TypeError, ValueError):
    pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(0);
  });

  it('does not flag `except Exception as e:`', () => {
    const src = `try:
    risky()
except Exception as e:
    log(e)`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(0);
  });

  it('reports correct line number for indented bare except', () => {
    const src = `def fn():
    try:
        risky()
    except:
        pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(1);
    expect(violations[0]?.line).toBe(4);
  });

  it('flags multiple bare excepts independently', () => {
    const src = `try:
    a()
except:
    pass
try:
    b()
except:
    pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(2);
    expect(violations[0]?.line).toBe(3);
    expect(violations[1]?.line).toBe(7);
  });

  it('tolerates whitespace between `except` and `:`', () => {
    const src = `try:
    a()
except :
    pass`;
    const violations = analyzeBareExcept(src);
    expect(violations.length).toBe(1);
  });
});
