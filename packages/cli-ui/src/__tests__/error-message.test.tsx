import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { ErrorMessage } from '../error-message.js';

describe('ErrorMessage', () => {
  it('renders ✗ + message without a suggestion', () => {
    const { lastFrame } = render(<ErrorMessage message="something went wrong" />);
    const out = lastFrame() ?? '';
    expect(out).toContain('✗');
    expect(out).toContain('something went wrong');
    // No suggestion line — no extra line beyond the message and trailing newline.
    const nonEmpty = out.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBe(1);
  });

  it('renders the suggestion when provided', () => {
    const { lastFrame } = render(<ErrorMessage message="bad input" suggestion="try --help" />);
    const out = lastFrame() ?? '';
    expect(out).toContain('bad input');
    expect(out).toContain('try --help');
  });
});
