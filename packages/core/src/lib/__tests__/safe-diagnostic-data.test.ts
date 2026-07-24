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

  it('redacts nested secret-ish keys in objects', () => {
    const v = toSafeDiagnosticData({
      ok: true,
      password: 'hunter2',
      nested: { apiKey: 'abc', count: 1 },
    });
    const text = JSON.stringify(v);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc');
    expect(text).toContain('count');
  });

  it('bounds long text and strips control characters', () => {
    const long = `${'a'.repeat(3000)}\u0001\u0002`;
    const scrubbed = scrubText(long, 100);
    expect(scrubbed.length).toBeLessThanOrEqual(100);
    expect(scrubbed).not.toMatch(/[\u0001\u0002]/);
  });

  it('neutralizes terminal ANSI before control scrubbing', () => {
    const colored = '\u001B[31msecret\u001B[0m\u0000';
    expect(neutralizeTerminalText(colored)).toBe('secret');
  });

  it('never serializes raw Error cause stacks as free-form objects', () => {
    const err = new Error('top', { cause: new Error('inner') });
    const v = toSafeDiagnosticData(err);
    expect(v).toMatchObject({ note: 'error-object-redacted' });
    expect(JSON.stringify(v)).not.toContain('stack');
  });
});
