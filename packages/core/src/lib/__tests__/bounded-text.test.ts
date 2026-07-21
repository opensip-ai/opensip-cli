import { describe, expect, it } from 'vitest';

import { appendBoundedUtf8Text } from '../bounded-text.js';

describe('appendBoundedUtf8Text', () => {
  it('M18: does not leave a lone high surrogate when truncating mid-pair', () => {
    // U+1F600 😀 is a surrogate pair in JS strings (length 2).
    const emoji = '😀';
    const out = appendBoundedUtf8Text('', Buffer.from(emoji, 'utf8'), 1);
    expect(out.truncated).toBe(true);
    // Cap of 1 code unit would cut after the high surrogate; drop it instead.
    expect(out.value).toBe('');
    expect(out.value).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('appends chunks until the limit is reached', () => {
    expect(appendBoundedUtf8Text('abc', Buffer.from('def'), 6)).toEqual({
      value: 'abcdef',
      truncated: false,
    });
  });

  it('truncates at the configured limit', () => {
    expect(appendBoundedUtf8Text('abc', Buffer.from('def'), 5)).toEqual({
      value: 'abcde',
      truncated: true,
    });
  });

  it('keeps the existing buffer when it is already at or past the limit', () => {
    expect(appendBoundedUtf8Text('abcdef', Buffer.from('xyz'), 6)).toEqual({
      value: 'abcdef',
      truncated: true,
    });
    expect(appendBoundedUtf8Text('abcdefg', Buffer.from('xyz'), 6)).toEqual({
      value: 'abcdef',
      truncated: true,
    });
    expect(appendBoundedUtf8Text('abc', Buffer.from('xyz'), 0)).toEqual({
      value: '',
      truncated: true,
    });
  });
});
