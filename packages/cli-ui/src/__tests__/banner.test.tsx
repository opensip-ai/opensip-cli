import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Banner, normalizeBannerSize } from '../banner.js';

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

  describe('mini', () => {
    it('renders a boxed identity card with cup, version, tagline, and path', () => {
      const frame = render(
        <Banner size="mini" version="2.2.1" projectPath="/home/me/opensip-tools" />,
      ).lastFrame() ?? '';
      expect(frame).toContain('opensip-tools');
      expect(frame).toContain('v2.2.1');
      expect(frame).toContain('codebase analysis toolkit');
      expect(frame).toContain('/home/me/opensip-tools');
      // Rounded amber box frames the card.
      expect(frame).toContain('╭');
      expect(frame).toContain('╯');
      // Cup body present.
      expect(frame).toContain('███');
      // No full-size saucer line — this is not the lg banner.
      expect(frame).not.toContain('░███████████░');
    });

    it('omits the project-path line when no projectPath is given', () => {
      const frame = render(<Banner size="mini" version="2.2.1" />).lastFrame() ?? '';
      expect(frame).toContain('opensip-tools');
      expect(frame).toContain('v2.2.1');
      expect(frame).not.toContain('/home/me');
    });
  });
});

describe('normalizeBannerSize', () => {
  it('passes through every valid size', () => {
    expect(normalizeBannerSize('lg')).toBe('lg');
    expect(normalizeBannerSize('md')).toBe('md');
    expect(normalizeBannerSize('sm')).toBe('sm');
    expect(normalizeBannerSize('mini')).toBe('mini');
  });

  it('falls back to lg for unknown or undefined values', () => {
    expect(normalizeBannerSize('enormous')).toBe('lg');
    expect(normalizeBannerSize('')).toBe('lg');
    expect(normalizeBannerSize(undefined)).toBe('lg');
  });
});
