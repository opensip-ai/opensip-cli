/**
 * @fileoverview Tests for the fault.* builders.
 */

import { describe, expect, it } from 'vitest';

import { fault } from '../fault-builders.js';

describe('fault builders', () => {
  it('latency', () => {
    expect(fault.latency({ ms: 5 })).toEqual({ kind: 'latency', ms: 5 });
  });
  it('abort', () => {
    expect(fault.abort()).toEqual({ kind: 'abort' });
  });
  it('drop', () => {
    expect(fault.drop()).toEqual({ kind: 'drop' });
  });
  it('of assembles a probability-gated spec', () => {
    expect(fault.of([fault.drop(), fault.abort()], { probability: 0.3 })).toEqual({
      faults: [{ kind: 'drop' }, { kind: 'abort' }],
      probability: 0.3,
    });
  });
});
