import { describe, expect, it } from 'vitest';

import { formatDuration } from '../format-duration.js';

describe('formatDuration', () => {
  it('keeps sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('uses seconds below the minute display boundary', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(59_949)).toBe('59.9s');
  });

  it('uses minutes and seconds at minute scale', () => {
    expect(formatDuration(59_950)).toBe('1m 0.0s');
    expect(formatDuration(60_000)).toBe('1m 0.0s');
    expect(formatDuration(119_999)).toBe('2m 0.0s');
    expect(formatDuration(1_471_600)).toBe('24m 31.6s');
  });
});
