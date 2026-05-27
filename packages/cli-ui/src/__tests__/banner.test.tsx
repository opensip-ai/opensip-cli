import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Banner } from '../banner.js';

describe('Banner', () => {
  it('renders 8 banner rows plus a saucer line', () => {
    const { lastFrame } = render(<Banner />);
    const output = lastFrame() ?? '';
    expect(output.split('\n').length).toBeGreaterThanOrEqual(9);
    expect(output).toContain('░███████████░');
  });

  it('includes the ASCII art glyphs for the cup and the OPENSIP letters', () => {
    const { lastFrame } = render(<Banner />);
    const output = lastFrame() ?? '';
    // First banner row's cup column starts with diamond glyphs.
    expect(output).toContain('░');
    // OPENSIP body uses block glyphs.
    expect(output).toContain('████');
  });
});
