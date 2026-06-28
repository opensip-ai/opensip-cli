import { describe, expect, it } from 'vitest';

import { redactSecret, secretHash } from '../redact.js';

describe('redactSecret', () => {
  it('returns a first-4 preview and NEVER the raw secret', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const preview = redactSecret(secret);
    expect(preview).toBe('AKIA…');
    expect(preview).not.toContain('IOSFODNN7EXAMPLE');
    expect(preview).not.toBe(secret);
  });

  it('collapses short values so the raw is never returned', () => {
    expect(redactSecret('abcd')).toBe('…');
    expect(redactSecret('ab')).toBe('…');
    expect(redactSecret('abcde')).not.toBe('abcde');
  });

  it('handles empty / nullish', () => {
    expect(redactSecret('')).toBe('');
    expect(redactSecret(undefined)).toBe('');
    expect(redactSecret(null)).toBe('');
  });
});

describe('secretHash', () => {
  it('is stable, short, and reveals nothing of the value', () => {
    const a = secretHash('AKIAIOSFODNN7EXAMPLE');
    const b = secretHash('AKIAIOSFODNN7EXAMPLE');
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(secretHash('other')).not.toBe(a);
  });

  it('handles empty / nullish', () => {
    expect(secretHash('')).toBe('');
    expect(secretHash(undefined)).toBe('');
    expect(secretHash(null)).toBe('');
  });
});
