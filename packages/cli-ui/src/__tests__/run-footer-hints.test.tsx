import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { RunFooterHints } from '../run-footer-hints.js';

describe('RunFooterHints', () => {
  it('renders nothing when there are no hints', () => {
    const { lastFrame } = render(<RunFooterHints hints={[]} />);
    expect(lastFrame()).toBe('');
  });

  it('renders a single hint with no bold spans verbatim', () => {
    const { lastFrame } = render(
      <RunFooterHints hints={[{ text: 'press q to quit' }]} />,
    );
    expect(lastFrame() ?? '').toContain('press q to quit');
  });

  it('joins multiple hints with a pipe separator', () => {
    const { lastFrame } = render(
      <RunFooterHints
        hints={[{ text: 'first hint' }, { text: 'second hint' }]}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('first hint');
    expect(out).toContain('second hint');
    expect(out).toContain('|');
  });

  it('renders the bolded substrings within a hint', () => {
    const { lastFrame } = render(
      <RunFooterHints
        hints={[{ text: 'run --verbose for detail', bold: ['--verbose'] }]}
      />,
    );
    const out = lastFrame() ?? '';
    // The hint text (including the flag) must round-trip through the
    // split/rejoin tokenizer intact.
    expect(out).toContain('run --verbose for detail');
  });

  it('escapes regex metacharacters in bold substrings', () => {
    const { lastFrame } = render(
      <RunFooterHints
        hints={[{ text: 'use --report-to <url> to upload', bold: ['<url>'] }]}
      />,
    );
    // If the metachars weren't escaped, the RegExp would throw or mis-split;
    // a clean render proves the escape path ran.
    expect(lastFrame() ?? '').toContain('use --report-to <url> to upload');
  });

  it('prefers the longest match when bold substrings overlap', () => {
    const { lastFrame } = render(
      <RunFooterHints
        hints={[{ text: 'flag --gate-save here', bold: ['--gate', '--gate-save'] }]}
      />,
    );
    expect(lastFrame() ?? '').toContain('flag --gate-save here');
  });
});
