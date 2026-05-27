import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ClockProvider, useClock, useTick } from '../clock.js';

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

function ProbeTick({ onTick, intervalMs }: Readonly<{ onTick: (n: number) => void; intervalMs?: number }>): React.ReactElement {
  const tick = useTick(intervalMs);
  onTick(tick);
  return <Text>{String(tick)}</Text>;
}

describe('useClock + ClockProvider', () => {
  it('exposes 0 when no provider is mounted', () => {
    const ticks: number[] = [];
    render(<ProbeClock onTick={(n) => ticks.push(n)} />);
    expect(ticks[0]).toBe(0);
  });

  it('advances the tick at the configured interval', async () => {
    const ticks: number[] = [];
    render(
      <ClockProvider intervalMs={50}>
        <ProbeClock onTick={(n) => ticks.push(n)} />
      </ClockProvider>,
    );
    expect(ticks.at(-1)).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(ticks.at(-1)).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(ticks.at(-1)).toBe(4);
  });

  it('uses the default interval when none is supplied', async () => {
    const ticks: number[] = [];
    render(
      <ClockProvider>
        <ProbeClock onTick={(n) => ticks.push(n)} />
      </ClockProvider>,
    );
    await vi.advanceTimersByTimeAsync(80);
    expect(ticks.at(-1)).toBe(1);
  });
});

describe('useTick (provider-free)', () => {
  it('returns 0 on initial render and increments on its own interval', async () => {
    const ticks: number[] = [];
    render(<ProbeTick intervalMs={30} onTick={(n) => ticks.push(n)} />);
    expect(ticks[0]).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(ticks.at(-1)).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(ticks.at(-1)).toBe(3);
  });

  it('uses the default interval when none is supplied', async () => {
    const ticks: number[] = [];
    render(<ProbeTick onTick={(n) => ticks.push(n)} />);
    await vi.advanceTimersByTimeAsync(80);
    expect(ticks.at(-1)).toBe(1);
  });
});
