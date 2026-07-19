import { describe, expect, it } from 'vitest';

import {
  ComputeImpactCancelledError,
  ComputeImpactIndexGenerationMismatchError,
} from '../index.js';

describe('graph-impact model error classes', () => {
  it('ComputeImpactCancelledError carries a stable name and message', () => {
    const error = new ComputeImpactCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ComputeImpactCancelledError');
    expect(error.message).toBe('Impact computation was cancelled.');
  });

  it('ComputeImpactIndexGenerationMismatchError carries a stable name and message', () => {
    const error = new ComputeImpactIndexGenerationMismatchError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ComputeImpactIndexGenerationMismatchError');
    expect(error.message).toBe(
      'ComputeImpactIndex belongs to a different graph catalog generation.',
    );
  });
});
