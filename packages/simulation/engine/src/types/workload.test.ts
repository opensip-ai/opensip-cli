import { describe, expect, it } from 'vitest';

import { resolveConcurrency } from './workload.js';

describe('resolveConcurrency', () => {
  it('derives a positive default from rps when concurrency is omitted', () => {
    expect(resolveConcurrency({ rps: 1 })).toBe(1);
    expect(resolveConcurrency({ rps: 10 })).toBe(2);
    expect(resolveConcurrency({ rps: 25 })).toBe(5);
  });

  it('honors an explicit positive concurrency', () => {
    expect(resolveConcurrency({ rps: 100, concurrency: 7 })).toBe(7);
  });

  it('clamps non-positive concurrency to 1 so the load window cannot hang', () => {
    expect(resolveConcurrency({ rps: 100, concurrency: 0 })).toBe(1);
    expect(resolveConcurrency({ rps: 100, concurrency: -3 })).toBe(1);
  });
});
