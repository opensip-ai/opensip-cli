import { describe, expect, it } from 'vitest';

import { generateSessionId, sanitizeForFilename } from '../persistence/store.js';

describe('generateSessionId', () => {
  it('returns a UUID-shaped string', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  });

  it('returns distinct ids on consecutive calls', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe('sanitizeForFilename', () => {
  it('replaces path separators with dashes', () => {
    expect(sanitizeForFilename(String.raw`a/b\c`)).toBe('a-b-c');
  });

  it('replaces special filesystem characters with dashes', () => {
    expect(sanitizeForFilename('a:b*c?d"e<f>g|h.i')).toBe('a-b-c-d-e-f-g-h-i');
  });

  it('replaces parent-dir traversal sequences with dashes', () => {
    expect(sanitizeForFilename('a..b')).toBe('a-b');
    expect(sanitizeForFilename('....')).toBe('--');
  });

  it('passes through safe characters unchanged', () => {
    expect(sanitizeForFilename('safe-name_123')).toBe('safe-name_123');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeForFilename('')).toBe('');
  });
});
