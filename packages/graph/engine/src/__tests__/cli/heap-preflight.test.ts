/**
 * Unit tests for heap-preflight decision logic.
 *
 * The re-exec path is not exercised here — that requires spawning a
 * real child process and is covered by manual smoke testing. These
 * tests pin the pure decision functions so the policy thresholds
 * (1000 → 8192, 2500 → 12288) can't drift silently.
 */

import { describe, it, expect } from 'vitest';

import {
  HEAP_TARGETS,
  decideHeapTargetMb,
  systemHasMemoryFor,
  totalSystemMemoryMb,
} from '../../cli/heap-preflight.js';

describe('decideHeapTargetMb', () => {
  it('returns null below the lowest threshold', () => {
    expect(decideHeapTargetMb(0)).toBeNull();
    expect(decideHeapTargetMb(999)).toBeNull();
    expect(decideHeapTargetMb(1000)).toBeNull();
  });

  it('returns 8192 between the two thresholds (exclusive 1000, inclusive 2500)', () => {
    expect(decideHeapTargetMb(1001)).toBe(8192);
    expect(decideHeapTargetMb(2000)).toBe(8192);
    expect(decideHeapTargetMb(2500)).toBe(8192);
  });

  it('returns 12288 above the upper threshold', () => {
    expect(decideHeapTargetMb(2501)).toBe(12_288);
    expect(decideHeapTargetMb(10_000)).toBe(12_288);
  });

  it('exposes thresholds in descending order so future additions stay correct', () => {
    const thresholds = HEAP_TARGETS.map((t) => t.fileThreshold);
    const sorted = [...thresholds].sort((a, b) => b - a);
    expect(thresholds).toEqual(sorted);
  });
});

describe('systemHasMemoryFor', () => {
  it('reports true for a tiny ask the system can clearly satisfy', () => {
    expect(systemHasMemoryFor(64)).toBe(true);
  });

  it('reports false for an impossibly large ask', () => {
    const huge = totalSystemMemoryMb() + 1_000_000;
    expect(systemHasMemoryFor(huge)).toBe(false);
  });

  it('keeps a 2 GB OS headroom — denying asks that would consume all RAM', () => {
    const totalMb = totalSystemMemoryMb();
    // Ask for exactly total - 1 GB. The 2 GB headroom should refuse.
    expect(systemHasMemoryFor(totalMb - 1024)).toBe(false);
  });
});
