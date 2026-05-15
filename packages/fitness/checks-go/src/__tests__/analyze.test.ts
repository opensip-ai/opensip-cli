import { describe, expect, it } from 'vitest';

import { analyzeFmtPrint } from '../checks/no-fmt-print.js';

describe('analyzeFmtPrint', () => {
  it('flags fmt.Print', () => {
    const out = analyzeFmtPrint('fmt.Print("hello")');
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('Print');
    expect(out[0]?.severity).toBe('warning');
  });

  it('flags fmt.Println', () => {
    const out = analyzeFmtPrint('fmt.Println("hello")');
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('Println');
  });

  it('flags fmt.Printf', () => {
    const out = analyzeFmtPrint('fmt.Printf("%v", x)');
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain('Printf');
  });

  it('reports the correct line number', () => {
    const out = analyzeFmtPrint('package x\n\nfmt.Println("hi")\n');
    expect(out[0]?.line).toBe(3);
  });

  it('flags multiple occurrences on one line', () => {
    const out = analyzeFmtPrint('fmt.Print(a); fmt.Println(b)');
    expect(out).toHaveLength(2);
  });

  it('does not flag fmt.Sprint or fmt.Errorf', () => {
    expect(analyzeFmtPrint('fmt.Sprint(a)')).toHaveLength(0);
    expect(analyzeFmtPrint('fmt.Errorf("e")')).toHaveLength(0);
  });

  it('does not flag method-style Print on other receivers', () => {
    expect(analyzeFmtPrint('logger.Print(a)')).toHaveLength(0);
  });

  it('returns an empty list for content without fmt.Print*', () => {
    expect(analyzeFmtPrint('package main\nfunc main() {}')).toEqual([]);
  });
});
