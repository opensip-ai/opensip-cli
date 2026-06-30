import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Banner, UpdateHint, normalizeBannerSize } from '../banner.js';
import { ThemeProvider } from '../theme.js';

describe('Banner', () => {
  it('renders the boxed coffee-cup identity card by default', () => {
    const { lastFrame } = render(<Banner />);
    const output = lastFrame() ?? '';
    expect(output).toContain('OpenSIP CLI');
    expect(output).toContain('codebase intelligence from your terminal');
    expect(output).toContain('www.opensip.ai');
    expect(output).toContain('╭');
    expect(output).toContain('╯');
    expect(output).toContain('███');
  });

  it('defaults to the mini size when no size prop is given', () => {
    const fromDefault = render(<Banner />).lastFrame() ?? '';
    const fromExplicit = render(<Banner size="mini" />).lastFrame() ?? '';
    expect(fromDefault).toBe(fromExplicit);
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
      // No legacy wordmark saucer line — the coffee cup card is canonical.
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
  it('passes through the only valid size', () => {
    expect(normalizeBannerSize('mini')).toBe('mini');
  });

  it('falls back to mini for unknown, legacy, or undefined values', () => {
    expect(normalizeBannerSize('lg')).toBe('mini');
    expect(normalizeBannerSize('md')).toBe('mini');
    expect(normalizeBannerSize('sm')).toBe('mini');
    expect(normalizeBannerSize('enormous')).toBe('mini');
    expect(normalizeBannerSize('')).toBe('mini');
    expect(normalizeBannerSize(undefined)).toBe('mini');
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
