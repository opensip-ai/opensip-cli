import { describe, it, expect } from 'vitest';

import { formatProjectHeader } from '../project-header.js';

describe('formatProjectHeader', () => {
  it('formats without suffix when walkedUp is 0', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 0 })).toBe('ℹ Project: /x/y\n');
  });

  it('uses singular "level" for walkedUp = 1', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 1 })).toBe(
      'ℹ Project: /x/y  (found 1 level up)\n',
    );
  });

  it('uses plural "levels" for walkedUp > 1', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 2 })).toBe(
      'ℹ Project: /x/y  (found 2 levels up)\n',
    );
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 7 })).toBe(
      'ℹ Project: /x/y  (found 7 levels up)\n',
    );
  });
});
