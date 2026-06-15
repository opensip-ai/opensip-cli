import { describe, it, expect } from 'vitest';

import { formatDuration } from '../format.js';

describe('formatDuration', () => {
  it('renders sub-second durations as integer milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders one second up to one minute as fixed-one-decimal seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(59_949)).toBe('59.9s');
  });

  it('renders one minute and above as minutes plus fixed-one-decimal seconds', () => {
    expect(formatDuration(59_950)).toBe('1m 0.0s');
    expect(formatDuration(60_000)).toBe('1m 0.0s');
    expect(formatDuration(61_500)).toBe('1m 1.5s');
    expect(formatDuration(119_999)).toBe('2m 0.0s');
    expect(formatDuration(1_471_600)).toBe('24m 31.6s');
  });
});
