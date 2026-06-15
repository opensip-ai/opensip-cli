/**
 * Unit tests for lang-python/body-digest.ts.
 *
 * The digest functions define the catalog's `bodyHash` contract: walk
 * produces it, resolve consumes it. These tests assert the documented
 * normalization rules directly (rather than only through the walker,
 * which never feeds the digest a body that *starts* with a docstring):
 *
 *   - Leading triple-quoted docstrings are stripped so two bodies that
 *     differ only in their docstring hash identically.
 *   - `#` comments are stripped while `#` inside string literals is
 *     preserved.
 *   - Whitespace runs collapse, so reformatting alone does not change
 *     the hash.
 *   - The synthetic-body digest does NOT strip leading docstrings.
 */

import { describe, expect, it } from 'vitest';

import { digestPythonBody, digestSyntheticBody } from '../body-digest.js';

describe('lang-python body-digest', () => {
  it('strips a leading triple-quoted docstring before hashing', () => {
    const withDocstring = `"""module docstring."""\nx = compute()\n`;
    const withoutDocstring = `x = compute()\n`;
    expect(digestPythonBody(withDocstring).hash).toBe(digestPythonBody(withoutDocstring).hash);
  });

  it('strips a single-quoted triple docstring too', () => {
    const a = `'''doc'''\nreturn 1\n`;
    const b = `return 1\n`;
    expect(digestPythonBody(a).hash).toBe(digestPythonBody(b).hash);
  });

  it('does not strip a body that has no leading docstring', () => {
    // The match branch is NOT taken: text starts with code, so the
    // original text flows straight into whitespace normalization.
    const a = digestPythonBody(`return compute()\n`);
    const b = digestPythonBody(`return  compute()  \n`);
    // Same logical body, differing only by whitespace → identical hash.
    expect(a.hash).toBe(b.hash);
  });

  it('strips `#` comments but preserves `#` inside string literals', () => {
    const withComment = digestPythonBody(`x = 1  # trailing comment\n`);
    const withoutComment = digestPythonBody(`x = 1\n`);
    expect(withComment.hash).toBe(withoutComment.hash);

    const hashInString = digestPythonBody(`s = "value # not a comment"\n`);
    const stripped = digestPythonBody(`s = "value "\n`);
    // The `#` inside the string is preserved, so these differ.
    expect(hashInString.hash).not.toBe(stripped.hash);
  });

  it('synthetic-body digest keeps a leading docstring (no docstring strip)', () => {
    // digestSyntheticBody normalizes comments + whitespace only; the
    // leading-docstring strip is reserved for real function bodies.
    const withDoc = digestSyntheticBody(`"""doc"""\nx = 1\n`);
    const withoutDoc = digestSyntheticBody(`x = 1\n`);
    expect(withDoc.hash).not.toBe(withoutDoc.hash);
  });

  it('reports a non-zero body size for non-empty input', () => {
    const d = digestPythonBody(`return 1\n`);
    expect(d.size).toBeGreaterThan(0);
    expect(typeof d.hash).toBe('string');
    expect(d.hash.length).toBeGreaterThan(0);
  });
});
