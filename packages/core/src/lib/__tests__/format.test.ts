import { describe, it, expect } from 'vitest';

import { formatDuration } from '../format.js';

describe('formatDuration', () => {
  it('renders sub-second durations as integer milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders one second and above as fixed-one-decimal seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(12_340)).toBe('12.3s');
  });
});
