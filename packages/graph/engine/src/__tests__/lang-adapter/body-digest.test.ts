/**
 * Unit tests for the shared body-digest primitives.
 *
 * These live on the lang-adapter contract layer; every tree-sitter
 * adapter composes them as the normalize-to-hash tail of its `bodyHash`
 * pipeline (round-3 audit 2026-05-30, finding D). Exercising them
 * directly pins the contract — the whitespace normalization, the
 * canonical-text `size`, and the SHA-256 hash — at the unit level
 * instead of only via downstream adapter tests, so a regression here is
 * caught even if no adapter test happens to cover the changed edge.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashBody, normalizeWhitespace } from '../../lang-adapter/body-digest.js';

describe('normalizeWhitespace', () => {
  it('collapses every run of whitespace to a single space and trims', () => {
    expect(normalizeWhitespace('  a\t\t b\n\n  c  ')).toBe('a b c');
  });

  it('is idempotent on already-normalized text', () => {
    const once = normalizeWhitespace('foo  bar\nbaz');
    expect(normalizeWhitespace(once)).toBe(once);
  });

  it('returns the empty string for whitespace-only input', () => {
    expect(normalizeWhitespace('   \n\t  ')).toBe('');
  });
});

describe('hashBody', () => {
  it('hashes the canonical text with SHA-256 and reports its length as size', () => {
    const canonical = 'fn main() {}';
    expect(hashBody(canonical)).toEqual({
      hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      size: canonical.length,
    });
  });

  it('is deterministic — identical canonical text yields an identical digest', () => {
    expect(hashBody('return x + y;')).toEqual(hashBody('return x + y;'));
  });

  it('uses the canonical length (not the raw source) for size', () => {
    // Callers normalize before hashing; size tracks the hashed content.
    const normalized = normalizeWhitespace('  return   x  ');
    expect(normalized).toBe('return x');
    expect(hashBody(normalized).size).toBe('return x'.length);
  });

  it('matches the empty-string SHA-256 reference vector', () => {
    expect(hashBody('')).toEqual({
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      size: 0,
    });
  });
});
