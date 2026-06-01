import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { renderToText } from '../render-to-text.js';
import { RunSummary, viewRunSummary } from '../run-summary.js';
import { ThemeProvider } from '../theme.js';

describe('RunSummary', () => {
  it('renders the canonical pass/fail/errors/warnings/duration line', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={12} failed={3} errors={1} warnings={2} durationMs={450} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('12 Passed');
    expect(out).toContain('3 Failed');
    expect(out).toContain('1 Errors');
    expect(out).toContain('2 Warnings');
    expect(out).toContain('Duration');
  });

  it('formats sub-second durations in milliseconds', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={1} failed={0} errors={0} warnings={0} durationMs={999} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('999ms');
  });

  it('formats durations of one second or more in seconds with one decimal', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={1} failed={0} errors={0} warnings={0} durationMs={1500} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('1.5s');
  });

  it('plain-text form matches the legacy writeRunSummaryPlain string (byte parity)', () => {
    // Locks the format graph's deleted writeRunSummaryPlain produced, so the
    // Phase 3 migration is provably content-preserving on the piped path.
    expect(renderToText(viewRunSummary({ passed: 12, failed: 3, errors: 1, warnings: 2, durationMs: 450 }))).toBe(
      '12 Passed, 3 Failed (1 Errors, 2 Warnings) | Duration 450ms',
    );
  });

  it('renders the all-zero (no errors/warnings/failures) shape', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={5} failed={0} errors={0} warnings={0} durationMs={10} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('5 Passed');
    expect(out).toContain('0 Failed');
    expect(out).toContain('0 Errors');
    expect(out).toContain('0 Warnings');
  });
});
