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
});
