/**
 * <LiveProgress> (ADR-0016) — the shared live-run renderer, in both modes:
 *   - phases: a checklist (pending ○ / running spinner / done ✓ / cached)
 *   - pool:   a single spinner + completed/total counter
 *
 * Driven by a controllable `subscribe` so the test pushes ProgressEvents and
 * inspects the rendered frame. The assertions check event-driven state (labels,
 * ✓, counters) — not the animated spinner frame — so they're deterministic;
 * `waitForFrame` polls the latest frame to absorb React's async re-render.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { ClockProvider } from '../clock.js';
import { LiveProgress } from '../live-progress.js';
import { ThemeProvider } from '../theme.js';

import type { ProgressCallback, ProgressEvent, ProgressSurface } from '../progress-event.js';

/** A subscribe fn that captures the renderer's listener so the test can push
 *  events into <LiveProgress> after it mounts. */
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

function mount(
  surface: ProgressSurface,
  subscribe: (cb: ProgressCallback) => void,
): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ClockProvider>
        <LiveProgress surface={surface} subscribe={subscribe} />
      </ClockProvider>
    </ThemeProvider>,
  );
}

/** Poll the latest frame until it contains `substr` (or time out), absorbing
 *  React's async re-render without depending on a single fixed delay. */
async function waitForFrame(lastFrame: () => string | undefined, substr: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((lastFrame() ?? '').includes(substr)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

const PHASES: ProgressSurface = {
  shape: 'phases',
  stages: [
    { id: 'discover', label: 'Discover files' },
    { id: 'parse', label: 'Parse project', runningDetail: 'Building AST...' },
    { id: 'rules', label: 'Evaluate rules' },
  ],
};

describe('<LiveProgress> — phases mode', () => {
  it('renders every stage as pending (○) before any event', async () => {
    const { subscribe } = controllable();
    const { lastFrame, unmount } = mount(PHASES, subscribe);
    await waitForFrame(lastFrame, '○ Discover files');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('○ Discover files');
    expect(frame).toContain('○ Parse project');
    expect(frame).toContain('○ Evaluate rules');
    unmount();
  });

  it('shows the running stage with its detail, then ✓ + duration when done', async () => {
    const { subscribe, emit } = controllable();
    const { lastFrame, unmount } = mount(PHASES, subscribe);
    await waitForFrame(lastFrame, 'Discover files');

    emit({ type: 'stage-start', stage: 'parse', label: 'Parse project' });
    await waitForFrame(lastFrame, 'Building AST...');
    expect(lastFrame()).toContain('Building AST...');

    emit({ type: 'stage-done', stage: 'parse', durationMs: 3400, detail: 'TypeScript' });
    await waitForFrame(lastFrame, 'TypeScript (3.4s)');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✓');
    expect(frame).toContain('Parse project');
    expect(frame).toContain('TypeScript (3.4s)');
    unmount();
  });

  it('formats minute-scale stage durations in minutes and seconds', async () => {
    const { subscribe, emit } = controllable();
    const { lastFrame, unmount } = mount(PHASES, subscribe);
    await waitForFrame(lastFrame, 'Discover files');

    emit({
      type: 'stage-done',
      stage: 'rules',
      durationMs: 1_471_600,
      detail: '318541 call site(s)',
    });
    await waitForFrame(lastFrame, '318541 call site(s) (24m 31.6s)');
    expect(lastFrame()).toContain('✓ Evaluate rules');
    unmount();
  });

  it('renders a cache hit as (cached)', async () => {
    const { subscribe, emit } = controllable();
    const { lastFrame, unmount } = mount(PHASES, subscribe);
    await waitForFrame(lastFrame, 'Discover files');
    emit({ type: 'stage-cached', stage: 'discover' });
    await waitForFrame(lastFrame, '(cached)');
    expect(lastFrame()).toContain('(cached)');
    unmount();
  });
});

describe('<LiveProgress> — pool mode', () => {
  const POOL: ProgressSurface = { shape: 'pool', label: 'Running checks...' };

  it('shows the label and updates the completed/total counter', async () => {
    const { subscribe, emit } = controllable();
    const { lastFrame, unmount } = mount(POOL, subscribe);
    await waitForFrame(lastFrame, 'Running checks...');

    emit({ type: 'stage-progress', stage: 'checks', completed: 5, total: 10 });
    await waitForFrame(lastFrame, '5/10 (50%)');
    expect(lastFrame()).toContain('5/10 (50%)');

    emit({ type: 'stage-progress', stage: 'checks', completed: 10, total: 10 });
    await waitForFrame(lastFrame, '10/10 (100%)');
    expect(lastFrame()).toContain('10/10 (100%)');
    unmount();
  });

  it('reflects the latest count when concurrent completions arrive out of step', async () => {
    const { subscribe, emit } = controllable();
    const { lastFrame, unmount } = mount(POOL, subscribe);
    await waitForFrame(lastFrame, 'Running checks...');
    // Concurrent scenarios (sim parallel mode) report a monotonic completed count.
    emit({ type: 'stage-progress', stage: 'scenarios', completed: 3, total: 8 });
    emit({ type: 'stage-progress', stage: 'scenarios', completed: 7, total: 8 });
    await waitForFrame(lastFrame, '7/8');
    expect(lastFrame()).toContain('7/8');
    unmount();
  });
});
