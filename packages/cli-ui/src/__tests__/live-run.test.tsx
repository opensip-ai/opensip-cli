import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { ClockProvider } from '../clock.js';
import { LiveRun } from '../live-run.js';
import { ThemeProvider } from '../theme.js';

import type { ProgressCallback, ProgressEvent, ProgressSurface } from '../progress-event.js';

function mount(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <ClockProvider>{ui}</ClockProvider>
    </ThemeProvider>,
  );
}

function controllable(): {
  subscribe: (cb: ProgressCallback) => void;
  emit: (e: ProgressEvent) => void;
} {
  let listener: ProgressCallback | undefined;
  return {
    subscribe: (cb) => {
      listener = cb;
    },
    emit: (e) => listener?.(e),
  };
}

async function waitForFrame(lastFrame: () => string | undefined, substr: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((lastFrame() ?? '').includes(substr)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const PHASE_SURFACE: ProgressSurface = {
  shape: 'phases',
  stages: [{ id: 'parse', label: 'Parse project' }],
};

const noopSubscribe: (cb: ProgressCallback) => void = () => {
  // no events needed — tests that only inspect chrome (e.g. the banner)
};

describe('<LiveRun>', () => {
  it('renders the loading frame', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{ phase: 'loading' }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).toContain('Working');
  });

  it('renders the error frame', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{ phase: 'error', message: 'boom' }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).toContain('boom');
  });

  it('omits verbose lines when verbose is false', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{
          phase: 'done',
          data: {
            summary: { passed: true, errors: 0, warnings: 0 },
            verboseLines: ['secret detail'],
          },
        }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).not.toContain('secret detail');
  });

  it('renders a FAULT headline + attention bullets on the compact done surface', () => {
    // Parity with the static (pipe) surface: the live done-body must read FAULT
    // (not FAIL) and list the failed/faulted units with their detail.
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{
          phase: 'done',
          data: {
            summary: { passed: false, faulted: true, errors: 2, warnings: 1, durationMs: 5 },
            attention: {
              counts: { passed: 2, failed: 1, faulted: 1 },
              items: [
                { label: 'no-console', outcome: 'failed', detail: 'src/api.ts:42' },
                { label: 'complexity', outcome: 'faulted', detail: 'threw RangeError' },
              ],
            },
          },
        }}
        verbose={false}
        quiet={false}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('FAULT');
    expect(out).not.toContain('FAIL');
    expect(out).toContain('2/4 passed');
    expect(out).toContain('1/4 faulted');
    expect(out).toContain('no-console');
    expect(out).toContain('src/api.ts:42');
    expect(out).toContain('complexity');
    expect(out).toContain('threw RangeError');
  });

  it('renders a custom done-body that REPLACES the default summary/attention block', () => {
    // The suite live view supplies its own aggregate as `data.body`; it must own
    // the whole done frame, so the default RunSummary/attention block is skipped.
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Suite audit', description: 'Running suite steps' }}
        surface={PHASE_SURFACE}
        state={{
          phase: 'done',
          data: {
            summary: { passed: false, errors: 3, warnings: 0, durationMs: 5 },
            attention: {
              counts: { passed: 0, failed: 1, faulted: 0 },
              items: [{ label: 'DEFAULT_ATTENTION_MARKER', outcome: 'failed', detail: 'x' }],
            },
            body: { kind: 'heading', text: 'CUSTOM_SUITE_BODY' },
          },
        }}
        verbose={false}
        quiet={false}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('CUSTOM_SUITE_BODY');
    // The default attention block (which would otherwise render) is replaced.
    expect(out).not.toContain('DEFAULT_ATTENTION_MARKER');
  });

  it('suppresses attention bullets under --verbose (the full table is shown instead)', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{
          phase: 'done',
          data: {
            summary: { passed: false, faulted: false, errors: 1, warnings: 0, durationMs: 5 },
            attention: {
              counts: { passed: 0, failed: 1, faulted: 0 },
              items: [{ label: 'no-console', outcome: 'failed', detail: 'src/api.ts:42' }],
            },
          },
        }}
        verbose
        quiet={false}
      />,
    );
    // Under --verbose the attention block is suppressed (the per-unit table owns
    // the detail); the count-line fraction must not appear.
    expect(lastFrame() ?? '').not.toContain('1/1 failed');
  });

  it('omits verbose lines when quiet is true', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{
          phase: 'done',
          data: {
            summary: { passed: true, errors: 0, warnings: 0 },
            verboseLines: ['quiet detail'],
          },
        }}
        verbose
        quiet
      />,
    );
    expect(lastFrame()).not.toContain('quiet detail');
  });

  it('uses explicit summary duration when no run timer is available', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <LiveRun
          meta={{ title: 'Test Tool', description: 'Running test' }}
          surface={{ shape: 'pool', label: 'Working...' }}
          state={{
            phase: 'done',
            data: {
              summary: { passed: true, errors: 0, warnings: 0, durationMs: 1234 },
            },
          }}
          verbose={false}
          quiet
        />
      </ThemeProvider>,
    );
    expect(lastFrame()).toContain('1.2s');
  });

  it('preserves phase progress when rendering the done frame', async () => {
    const { subscribe, emit } = controllable();
    const ui = (state: React.ComponentProps<typeof LiveRun>['state']) => (
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={PHASE_SURFACE}
        state={state}
        verbose={false}
        quiet
      />
    );
    const { lastFrame, rerender } = mount(ui({ phase: 'running', subscribe }));

    await waitForFrame(lastFrame, 'Parse project');
    emit({ type: 'stage-done', stage: 'parse', durationMs: 1234, detail: '42 file(s)' });
    await waitForFrame(lastFrame, '42 file(s) (1.2s)');

    rerender(
      <ThemeProvider>
        <ClockProvider>
          {ui({
            phase: 'done',
            subscribe,
            data: { summary: { passed: true, errors: 0, warnings: 0 } },
          })}
        </ClockProvider>
      </ThemeProvider>,
    );

    expect(lastFrame()).toContain('42 file(s) (1.2s)');
  });

  // Banner rendering is shell-owned and uniform: every tool renders it the
  // same way (a single <Static> banner) with no per-tool opt-in. This guards
  // against the duplicate-banner regression — the banner must appear exactly
  // once per frame, in every phase, never zero (missing) and never twice.
  it('renders the banner exactly once in every phase', () => {
    const bannerMarker = 'www.opensip.ai'; // mini banner URL — stable substring
    const ui = (state: React.ComponentProps<typeof LiveRun>['state']) => (
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={state}
        verbose={false}
        quiet={false}
        ui={{ bannerSize: 'mini', version: '9.9.9' }}
      />
    );
    const countBanner = (frame: string | undefined): number =>
      (frame ?? '').split(bannerMarker).length - 1;

    const { lastFrame, rerender } = mount(ui({ phase: 'loading' }));
    expect(countBanner(lastFrame())).toBe(1);

    rerender(
      <ThemeProvider>
        <ClockProvider>{ui({ phase: 'running', subscribe: noopSubscribe })}</ClockProvider>
      </ThemeProvider>,
    );
    expect(countBanner(lastFrame())).toBe(1);

    rerender(
      <ThemeProvider>
        <ClockProvider>
          {ui({ phase: 'done', data: { summary: { passed: true, errors: 0, warnings: 0 } } })}
        </ClockProvider>
      </ThemeProvider>,
    );
    expect(countBanner(lastFrame())).toBe(1);
  });

  it('omits the banner when quiet', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{ phase: 'loading' }}
        verbose={false}
        quiet
        ui={{ bannerSize: 'mini', version: '9.9.9' }}
      />,
    );
    expect(lastFrame()).not.toContain('www.opensip.ai');
  });
});
