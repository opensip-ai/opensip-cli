import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { renderToText } from '../render-to-text.js';
import { RunSummary, viewRunSummary } from '../run-summary.js';
import { ThemeProvider } from '../theme.js';

describe('RunSummary', () => {
  it('renders the PASS verdict + errors/warnings/duration line (ADR-0035)', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={1} warnings={2} durationMs={450} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('PASS');
    expect(out).not.toContain('Passed');
    expect(out).toContain('1 Errors');
    expect(out).toContain('2 Warnings');
    expect(out).toContain('Duration');
  });

  it('renders the FAIL verdict when the run did not pass', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={false} errors={3} warnings={0} durationMs={20} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('FAIL');
    expect(out).toContain('3 Errors');
  });

  it('reflects the verdict, not the counts: a warning-only PASS run shows PASS with N Warnings', () => {
    // ADR-0035: with failOnWarnings:0 the run passes despite warnings; the
    // headline leads with PASS while still surfacing the warning count.
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={0} warnings={5} durationMs={10} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('PASS');
    expect(out).toContain('5 Warnings');
  });

  it('formats sub-second durations in milliseconds', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={0} warnings={0} durationMs={999} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('999ms');
  });

  it('formats durations from one second up to one minute in seconds with one decimal', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={0} warnings={0} durationMs={1500} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('1.5s');
  });

  it('formats durations of one minute or more in minutes and seconds', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={0} warnings={0} durationMs={1_471_600} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? '').toContain('24m 31.6s');
  });

  it('plain-text form is the canonical PASS/FAIL string (TTY === piped byte parity)', () => {
    expect(
      renderToText(viewRunSummary({ passed: true, errors: 1, warnings: 2, durationMs: 450 })),
    ).toBe('PASS  (1 Errors, 2 Warnings) | Duration 450ms');
    expect(
      renderToText(viewRunSummary({ passed: false, errors: 3, warnings: 0, durationMs: 20 })),
    ).toBe('FAIL  (3 Errors, 0 Warnings) | Duration 20ms');
  });

  it('renders the all-clean PASS shape', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <RunSummary passed={true} errors={0} warnings={0} durationMs={10} />
      </ThemeProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('PASS');
    expect(out).toContain('0 Errors');
    expect(out).toContain('0 Warnings');
  });
});
