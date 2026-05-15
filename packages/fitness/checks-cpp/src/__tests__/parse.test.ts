import { describe, expect, it } from 'vitest';

import { parseClangTidyOutput } from '../checks/clang-tidy-passthrough.js';

describe('parseClangTidyOutput', () => {
  it('parses a warning line with a [check-name] tag', () => {
    const out = parseClangTidyOutput(
      'src/foo.cpp:42:10: warning: unused variable [misc-unused]',
      '',
      0,
      [],
      '',
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('warning');
    expect(out[0]?.line).toBe(42);
    expect(out[0]?.message).toContain('[misc-unused]');
    expect(out[0]?.message).toContain('unused variable');
  });

  it('parses an error line', () => {
    const out = parseClangTidyOutput(
      'src/x.cpp:5:1: error: something exploded [bugprone-foo]',
      '',
      0,
      [],
      '',
    );
    expect(out[0]?.severity).toBe('error');
  });

  it('parses a line without a [check-name] tag', () => {
    const out = parseClangTidyOutput('src/y.cpp:1:1: warning: unparsed', '', 0, [], '');
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe('unparsed');
  });

  it('skips note: lines', () => {
    const out = parseClangTidyOutput(
      'src/a.cpp:1:1: warning: w [misc]\nsrc/a.cpp:1:1: note: more info',
      '',
      0,
      [],
      '',
    );
    expect(out).toHaveLength(1);
  });

  it('skips lines that do not match the expected format', () => {
    const out = parseClangTidyOutput(
      'random output\n2 warnings generated.\n',
      '',
      0,
      [],
      '',
    );
    expect(out).toEqual([]);
  });

  it('handles empty output', () => {
    expect(parseClangTidyOutput('', '', 0, [], '')).toEqual([]);
  });

  it('parses multiple diagnostics', () => {
    const stdout = 'a.cpp:1:1: warning: w1 [m1]\nb.cpp:2:2: error: e1 [m2]';
    const out = parseClangTidyOutput(stdout, '', 0, [], '');
    expect(out).toHaveLength(2);
    expect(out[0]?.severity).toBe('warning');
    expect(out[1]?.severity).toBe('error');
  });
});
