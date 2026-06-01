import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { formatProjectHeader, ProjectHeader } from '../project-header.js';

describe('formatProjectHeader', () => {
  it('formats without suffix when walkedUp is 0', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 0 })).toBe('ℹ Project: /x/y');
  });

  it('defaults walkedUp to 0 when omitted', () => {
    expect(formatProjectHeader({ root: '/x/y' })).toBe('ℹ Project: /x/y');
  });

  it('uses singular "level" for walkedUp = 1', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 1 })).toBe(
      'ℹ Project: /x/y  (found 1 level up)',
    );
  });

  it('uses plural "levels" for walkedUp > 1', () => {
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 2 })).toBe(
      'ℹ Project: /x/y  (found 2 levels up)',
    );
    expect(formatProjectHeader({ root: '/x/y', walkedUp: 7 })).toBe(
      'ℹ Project: /x/y  (found 7 levels up)',
    );
  });
});

describe('<ProjectHeader />', () => {
  it('renders the formatted project line', () => {
    const { lastFrame } = render(<ProjectHeader root="/home/me/proj" />);
    expect(lastFrame() ?? '').toContain('ℹ Project: /home/me/proj');
  });

  it('includes the walk-up suffix when walkedUp is set', () => {
    const { lastFrame } = render(<ProjectHeader root="/home/me/proj" walkedUp={2} />);
    expect(lastFrame() ?? '').toContain('(found 2 levels up)');
  });
});
