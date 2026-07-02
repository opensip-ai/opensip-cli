import { describe, expect, it } from 'vitest';

import { appendBoundedUtf8Text } from '../bounded-text.js';

describe('appendBoundedUtf8Text', () => {
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
});
