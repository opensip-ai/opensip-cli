import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashBody, normalizeWhitespace } from './body-digest.js';
import { findDuplicateBodies } from './find-duplicate-bodies.js';
import { digestCanonicalBody } from './near-duplicate-signature.js';

describe('body-digest primitives (byte-stable relocation)', () => {
  it('normalizeWhitespace collapses runs and trims', () => {
    expect(normalizeWhitespace('  a\t\t b\n\n  c  ')).toBe('a b c');
  });

  it('hashBody is deterministic SHA-256 over canonical text', () => {
    const canonical = 'fn main() {}';
    expect(hashBody(canonical)).toEqual({
      hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      size: canonical.length,
    });
  });

  it('digestCanonicalBody returns hash, size, and signature', () => {
    const body =
      'function processItems(items) { const out = []; for (const item of items) { out.push(transform(item)); } return out; }';
    const d = digestCanonicalBody(body);
    expect(d.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(d.size).toBeGreaterThan(0);
    expect(d.signature?.length).toBe(128);
  });

  it('findDuplicateBodies returns empty for no candidates (A8)', () => {
    expect(findDuplicateBodies([])).toEqual({ aggregates: [], groups: [] });
  });
});
