import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ClockProvider } from '../clock.js';
import { Spinner, useSpinner, useStandaloneSpinner } from '../spinner.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function ProbeSpinner({ onFrame }: Readonly<{ onFrame: (s: string) => void }>): React.ReactElement {
  const f = useSpinner();
  onFrame(f);
  return <Text>{f}</Text>;
}

function ProbeStandalone({
  onFrame,
  intervalMs,
}: Readonly<{ onFrame: (s: string) => void; intervalMs?: number }>): React.ReactElement {
  const f = useStandaloneSpinner(intervalMs);
  onFrame(f);
  return <Text>{f}</Text>;
}

describe('useSpinner / useStandaloneSpinner', () => {
  it('emits a braille frame on initial render', () => {
    const frames: string[] = [];
    render(
      <ClockProvider intervalMs={10}>
        <ProbeSpinner onFrame={(s) => frames.push(s)} />
      </ClockProvider>,
    );
    expect(frames[0]).toBe('⠋');
  });

  it('cycles through the braille frames over time', async () => {
    const frames: string[] = [];
    render(
      <ClockProvider intervalMs={10}>
        <ProbeSpinner onFrame={(s) => frames.push(s)} />
      </ClockProvider>,
    );
    await vi.advanceTimersByTimeAsync(50);
    // After 5 ticks the frame index should have advanced past frame 0.
    expect(new Set(frames).size).toBeGreaterThan(1);
  });

  it('standalone spinner advances without a provider', async () => {
    const frames: string[] = [];
    render(<ProbeStandalone intervalMs={10} onFrame={(s) => frames.push(s)} />);
    await vi.advanceTimersByTimeAsync(40);
    expect(new Set(frames).size).toBeGreaterThan(1);
  });
});

describe('<Spinner />', () => {
  it('renders the count and percent when total > 0', () => {
    const { lastFrame } = render(
      <ClockProvider intervalMs={10}>
        <Spinner total={10} completed={3} label="Working" />
      </ClockProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Working');
    expect(out).toContain('3/10');
    expect(out).toContain('(30%)');
  });

  it('omits the count when total = 0', () => {
    const { lastFrame } = render(
      <ClockProvider intervalMs={10}>
        <Spinner total={0} completed={0} />
      </ClockProvider>,
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('(');
    expect(out).toContain('Running...');
  });

  it('renders in standalone mode without a ClockProvider', () => {
    const { lastFrame } = render(<Spinner total={5} completed={2} standalone />);
    const out = lastFrame() ?? '';
    expect(out).toContain('2/5');
    expect(out).toContain('(40%)');
  });
});
