import { describe, it, expect } from 'vitest';

import { formatDuration } from './duration.js';

describe('formatDuration', () => {
  it('renders sub-second durations as integer milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('rounds fractional sub-second durations (performance.now() deltas)', () => {
    expect(formatDuration(639.6488329999999)).toBe('640ms');
    expect(formatDuration(0.4)).toBe('0ms');
  });

  it('promotes [999.5, 1000) to seconds instead of rendering "1000ms"', () => {
    expect(formatDuration(999.5)).toBe('1.0s');
    expect(formatDuration(999.9)).toBe('1.0s');
    expect(formatDuration(999.4)).toBe('999ms');
  });

  it('renders one second up to one minute as fixed-one-decimal seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(19_850)).toBe('19.9s');
    expect(formatDuration(59_949)).toBe('59.9s');
  });

  it('renders one minute and above as minutes plus fixed-one-decimal seconds', () => {
    expect(formatDuration(59_950)).toBe('1m 0.0s');
    expect(formatDuration(60_000)).toBe('1m 0.0s');
    expect(formatDuration(61_500)).toBe('1m 1.5s');
    expect(formatDuration(119_999)).toBe('2m 0.0s');
    expect(formatDuration(1_471_600)).toBe('24m 31.6s');
  });

  it('falls back to 0ms for non-finite and negative inputs', () => {
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(-1)).toBe('0ms');
  });
});
