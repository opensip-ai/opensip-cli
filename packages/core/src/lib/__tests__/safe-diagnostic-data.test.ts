import { describe, it, expect } from 'vitest';

import {
  toSafeDiagnosticData,
  toSafeDiagnosticRecord,
  neutralizeTerminalText,
  projectRelativePath,
  scrubText,
} from '../safe-diagnostic-data.js';

describe('safe-diagnostic-data', () => {
  it('redacts Error objects to name/message', () => {
    const v = toSafeDiagnosticData(new Error('fail'));
    expect(v).toMatchObject({ name: 'Error', message: 'fail', note: 'error-object-redacted' });
  });

  it('scrubs credentials in URLs and control chars', () => {
    expect(scrubText('https://user:pass@host/x')).toContain('***:***');
    expect(scrubText('a\u0000b')).toBe('ab');
  });

  it('neutralizes ANSI for terminal', () => {
    expect(neutralizeTerminalText('\u001B[31mred\u001B[0m')).toBe('red');
  });

  it('projects paths relative to project root', () => {
    expect(projectRelativePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(projectRelativePath('/other/a.ts', '/repo')).toBe('[absolute-path]');
  });

  it('wraps scalars in records', () => {
    expect(toSafeDiagnosticRecord('hi')).toEqual({ value: 'hi' });
  });
});
