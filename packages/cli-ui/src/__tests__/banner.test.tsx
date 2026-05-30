import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Banner } from '../banner.js';

const widestLine = (frame: string): number =>
  Math.max(...frame.split('\n').map((line) => line.length));

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

  it('defaults to the lg size when no size prop is given', () => {
    const fromDefault = render(<Banner />).lastFrame() ?? '';
    const fromExplicit = render(<Banner size="lg" />).lastFrame() ?? '';
    expect(fromDefault).toBe(fromExplicit);
    // lg is the only size that carries the saucer line.
    expect(fromDefault).toContain('░███████████░');
  });

  it('renders a compact md banner: shorter than lg, keeps steam and block glyphs', () => {
    const lg = render(<Banner size="lg" />).lastFrame() ?? '';
    const md = render(<Banner size="md" />).lastFrame() ?? '';
    expect(md.split('\n').length).toBeLessThan(lg.split('\n').length);
    expect(md).toContain('░'); // steam survives
    expect(md).toContain('█'); // mug + wordmark glyphs
    expect(md).not.toContain('░███████████░'); // no full-size saucer line
  });

  it('renders an sm banner narrower than md', () => {
    const md = render(<Banner size="md" />).lastFrame() ?? '';
    const sm = render(<Banner size="sm" />).lastFrame() ?? '';
    expect(widestLine(sm)).toBeLessThan(widestLine(md));
    expect(sm).toContain('░'); // steam survives
  });
});
