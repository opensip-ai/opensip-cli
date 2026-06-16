import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Banner, UpdateHint, normalizeBannerSize } from '../banner.js';
import { ThemeProvider } from '../theme.js';

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
    it('renders a boxed identity card with cup, version, tagline, url, and path', () => {
      const frame =
        render(
          <Banner size="mini" version="2.2.1" projectPath="/home/me/opensip-cli" />,
        ).lastFrame() ?? '';
      expect(frame).toContain('OpenSIP CLI');
      expect(frame).toContain('v2.2.1');
      expect(frame).toContain('codebase intelligence from your terminal');
      expect(frame).toContain('www.opensip.ai');
      expect(frame).toContain('/home/me/opensip-cli');
      // Rounded amber box frames the card.
      expect(frame).toContain('╭');
      expect(frame).toContain('╯');
      // Cup body present.
      expect(frame).toContain('███');
      // No full-size saucer line — this is not the lg banner.
      expect(frame).not.toContain('░███████████░');
    });

    it('omits the project-path line but keeps the url when no projectPath is given', () => {
      const frame = render(<Banner size="mini" version="2.2.1" />).lastFrame() ?? '';
      expect(frame).toContain('OpenSIP CLI');
      expect(frame).toContain('v2.2.1');
      expect(frame).toContain('www.opensip.ai');
      expect(frame).not.toContain('/home/me');
    });

    it('shows the update flag on the version line when update is set', () => {
      const frame =
        render(
          <Banner size="mini" version="2.2.1" projectPath="/home/me" update="2.3.0" />,
        ).lastFrame() ?? '';
      expect(frame).toContain('v2.2.1');
      expect(frame).toContain('(v2.3.0 available)');
    });

    it('omits the update flag when update is not set', () => {
      const frame =
        render(<Banner size="mini" version="2.2.1" projectPath="/home/me" />).lastFrame() ?? '';
      expect(frame).not.toContain('available');
    });

    it('appends a singular "level" walk-up suffix for walkedUp=1', () => {
      const frame =
        render(
          <Banner size="mini" version="2.2.1" projectPath="/home/me" walkedUp={1} />,
        ).lastFrame() ?? '';
      expect(frame).toContain('(found 1 level up)');
    });

    it('appends a plural "levels" walk-up suffix for walkedUp>1', () => {
      const frame =
        render(
          <Banner size="mini" version="2.2.1" projectPath="/home/me" walkedUp={3} />,
        ).lastFrame() ?? '';
      expect(frame).toContain('(found 3 levels up)');
    });

    it('omits the walk-up suffix when walkedUp is 0', () => {
      const frame =
        render(
          <Banner size="mini" version="2.2.1" projectPath="/home/me" walkedUp={0} />,
        ).lastFrame() ?? '';
      expect(frame).not.toContain('found');
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

describe('UpdateHint', () => {
  it('renders the dim upgrade command line', () => {
    const frame =
      render(
        <ThemeProvider>
          <UpdateHint />
        </ThemeProvider>,
      ).lastFrame() ?? '';
    expect(frame).toContain('↑ Update:');
    expect(frame).toContain('curl -fsSL https://opensip.ai/cli/install.sh | bash');
  });
});
