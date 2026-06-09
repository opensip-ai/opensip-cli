/**
 * comment-openers — the shared comment-opener table (ADR-0014) and the
 * `stripCommentOpener` helper that removes a recognized opener from the start
 * of a trimmed line.
 */

import { describe, it, expect } from 'vitest';

import { COMMENT_OPENERS, stripCommentOpener } from './comment-openers.js';

describe('COMMENT_OPENERS', () => {
  it('encodes each opener with its correct character length', () => {
    expect(COMMENT_OPENERS).toEqual([
      ['//', 2],
      ['/*', 2],
      ['<!--', 4],
      ['#', 1],
    ]);
    for (const [opener, length] of COMMENT_OPENERS) {
      expect(opener.length).toBe(length);
    }
  });
});

describe('stripCommentOpener', () => {
  it('strips a line-comment opener', () => {
    expect(stripCommentOpener('// fitness-disable foo')).toBe(' fitness-disable foo');
  });

  it('strips a block-comment opener', () => {
    expect(stripCommentOpener('/* fitness-disable foo */')).toBe(' fitness-disable foo */');
  });

  it('strips an HTML/markdown opener (4 chars)', () => {
    expect(stripCommentOpener('<!-- fitness-disable foo -->')).toBe(' fitness-disable foo -->');
  });

  it('strips a hash opener (1 char)', () => {
    expect(stripCommentOpener('# fitness-disable foo')).toBe(' fitness-disable foo');
  });

  it('returns null for a line that does not start with any known opener', () => {
    expect(stripCommentOpener('const x = 1;')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(stripCommentOpener('')).toBeNull();
  });
});
