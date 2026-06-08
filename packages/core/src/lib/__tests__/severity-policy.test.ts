/**
 * SeverityPolicy + createSignalFromViolation — the consolidated severity home and
 * the generic identity-stamping factory (release 2.13.0, §5.9).
 */

import { describe, it, expect } from 'vitest';

import { createSignalFromViolation } from '../../signals/create-signal-from-violation.js';
import { SeverityPolicy } from '../severity-policy.js';

describe('SeverityPolicy', () => {
  it('lifts author severity UP (error → high, warning → medium)', () => {
    expect(SeverityPolicy.liftAuthorSeverity('error')).toBe('high');
    expect(SeverityPolicy.liftAuthorSeverity('warning')).toBe('medium');
  });

  it('applies an override only when set (baseline-neutral)', () => {
    expect(SeverityPolicy.applyOverride('low', undefined)).toBe('low'); // unchanged
    expect(SeverityPolicy.applyOverride('low', 'error')).toBe('high'); // clamped up
    expect(SeverityPolicy.applyOverride('high', 'warning')).toBe('medium'); // clamped down
  });

  it('isError is the error-rung predicate (critical/high)', () => {
    expect(SeverityPolicy.isError('critical')).toBe(true);
    expect(SeverityPolicy.isError('high')).toBe(true);
    expect(SeverityPolicy.isError('medium')).toBe(false);
    expect(SeverityPolicy.isError('low')).toBe(false);
  });
});

describe('createSignalFromViolation', () => {
  it('stamps source/ruleId and lifts severity', () => {
    const s = createSignalFromViolation('my-check', 'my-check', {
      message: 'bad thing',
      severity: 'error',
      suggestion: 'fix it',
      file: 'src/a.ts',
      line: 3,
      column: 1,
    });
    expect(s.source).toBe('my-check');
    expect(s.ruleId).toBe('my-check');
    expect(s.severity).toBe('high'); // error → high
    expect(s.message).toBe('bad thing');
    expect(s.suggestion).toBe('fix it');
    expect(s.code).toEqual({ file: 'src/a.ts', line: 3, column: 1 });
    expect(s.filePath).toBe('src/a.ts'); // mirrored by createSignal
  });

  it('lifts a warning to medium', () => {
    expect(createSignalFromViolation('x', 'x', { message: 'm', severity: 'warning' }).severity).toBe('medium');
  });
});
