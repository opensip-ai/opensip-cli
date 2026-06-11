import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ClockProvider, useClock, useTick } from '../clock.js';

// React 19's `act` warns when invoked outside an "act environment". We're not
// using @testing-library here (ink-testing-library doesn't wire this flag),
// so opt in manually so React's scheduler treats us as one.
const ACT_GLOBAL = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_GLOBAL.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Under React 19, state updates from intervals are batched and flushed
 * inside React's scheduler. Tests that assert exact tick counts after a
 * `vi.advanceTimersByTimeAsync(...)` need to drive the advance through
 * `act()` so React flushes the queued updates before we read state.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Wraps an ink-testing-library render so React 19's act-environment check is satisfied. */
function actRender<P>(node: React.ReactElement<P>): ReturnType<typeof render> {
  let handle: ReturnType<typeof render> | undefined;
  act(() => {
    handle = render(node);
  });
  if (!handle) throw new Error('render did not produce a handle');
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function ProbeClock({ onTick }: Readonly<{ onTick: (n: number) => void }>): React.ReactElement {
  const tick = useClock();
  onTick(tick);
  return <Text>{String(tick)}</Text>;
}

function ProbeTick({
  onTick,
  intervalMs,
}: Readonly<{ onTick: (n: number) => void; intervalMs?: number }>): React.ReactElement {
  const tick = useTick(intervalMs);
  onTick(tick);
  return <Text>{String(tick)}</Text>;
}

describe('useClock + ClockProvider', () => {
  it('exposes 0 when no provider is mounted', () => {
    const ticks: number[] = [];
    actRender(<ProbeClock onTick={(n) => ticks.push(n)} />);
    expect(ticks[0]).toBe(0);
  });

  it('advances the tick at the configured interval', async () => {
    const ticks: number[] = [];
    actRender(
      <ClockProvider intervalMs={50}>
        <ProbeClock onTick={(n) => ticks.push(n)} />
      </ClockProvider>,
    );
    expect(ticks.at(-1)).toBe(0);
    await advance(50);
    expect(ticks.at(-1)).toBe(1);
    await advance(150);
    expect(ticks.at(-1)).toBe(4);
  });

  it('uses the default interval when none is supplied', async () => {
    const ticks: number[] = [];
    actRender(
      <ClockProvider>
        <ProbeClock onTick={(n) => ticks.push(n)} />
      </ClockProvider>,
    );
    await advance(80);
    expect(ticks.at(-1)).toBe(1);
  });
});

describe('useTick (provider-free)', () => {
  it('returns 0 on initial render and increments on its own interval', async () => {
    const ticks: number[] = [];
    actRender(<ProbeTick intervalMs={30} onTick={(n) => ticks.push(n)} />);
    expect(ticks[0]).toBe(0);
    await advance(30);
    expect(ticks.at(-1)).toBe(1);
    await advance(60);
    expect(ticks.at(-1)).toBe(3);
  });

  it('uses the default interval when none is supplied', async () => {
    const ticks: number[] = [];
    actRender(<ProbeTick onTick={(n) => ticks.push(n)} />);
    await advance(80);
    expect(ticks.at(-1)).toBe(1);
  });
});
