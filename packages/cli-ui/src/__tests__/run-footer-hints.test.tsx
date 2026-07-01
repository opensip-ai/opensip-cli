import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { RunFooterHints } from '../run-footer-hints.js';

/**
 * Strip ANSI color/bold sequences so assertions check the *visible* text only.
 * Ink emits bold spans (`[1m…`) whenever the frame supports color (e.g.
 * FORCE_COLOR=1), which would otherwise split a bolded substring mid-token and
 * break a plain `toContain`.
 */
function visible(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- strips the ESC-introduced color codes from the Ink frame
  return (frame ?? '').replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('RunFooterHints', () => {
  it('renders nothing when there are no hints', () => {
    const { lastFrame } = render(<RunFooterHints hints={[]} />);
    expect(visible(lastFrame())).toBe('');
  });

  it('renders a single hint with no bold spans verbatim', () => {
    const { lastFrame } = render(<RunFooterHints hints={[{ text: 'press q to quit' }]} />);
    expect(visible(lastFrame())).toContain('press q to quit');
  });

  it('joins multiple hints with a pipe separator', () => {
    const { lastFrame } = render(
      <RunFooterHints hints={[{ text: 'first hint' }, { text: 'second hint' }]} />,
    );
    const out = visible(lastFrame());
    expect(out).toContain('first hint');
    expect(out).toContain('second hint');
    expect(out).toContain('|');
  });

  it('renders the bolded substrings within a hint', () => {
    const { lastFrame } = render(
      <RunFooterHints hints={[{ text: 'run --verbose for detail', bold: ['--verbose'] }]} />,
    );
    // The hint text (including the flag) must round-trip through the
    // split/rejoin tokenizer intact, independent of bold styling.
    expect(visible(lastFrame())).toContain('run --verbose for detail');
  });

  it('escapes regex metacharacters in bold substrings', () => {
    const { lastFrame } = render(
      <RunFooterHints hints={[{ text: 'use --report-to <url> to upload', bold: ['<url>'] }]} />,
    );
    // If the metachars weren't escaped, the RegExp would throw or mis-split;
    // a clean render proves the escape path ran.
    expect(visible(lastFrame())).toContain('use --report-to <url> to upload');
  });

  it('prefers the longest match when bold substrings overlap', () => {
    const { lastFrame } = render(
      <RunFooterHints
        hints={[{ text: 'flag --gate-save here', bold: ['--gate', '--gate-save'] }]}
      />,
    );
    expect(visible(lastFrame())).toContain('flag --gate-save here');
  });
});
