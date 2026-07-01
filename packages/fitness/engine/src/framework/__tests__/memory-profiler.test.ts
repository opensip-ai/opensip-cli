/**
 * @fileoverview Tests for the per-check memory profiler.
 *
 * Covers the public surface used by the recipe execution engine:
 * recordPrewarmComplete / recordCheckStart / recordCheckComplete plus
 * the threshold-tracking, summary, and reset paths.
 */

import { RunScope, applyToolContributeScope, runWithScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { memoryProfiler } from '../memory-profiler.js';

afterEach(() => {
  memoryProfiler.reset();
});

describe('memoryProfiler — basics', () => {
  it('returns a non-negative current memory reading in MB', () => {
    const mb = memoryProfiler.getCurrentMemoryMB();
    expect(typeof mb).toBe('number');
    expect(mb).toBeGreaterThan(0);
  });

  it('recordCheckStart returns the current heap snapshot in MB', () => {
    const before = memoryProfiler.recordCheckStart();
    expect(before).toBeGreaterThan(0);
  });

  it('exposes the configured warning threshold', () => {
    expect(memoryProfiler.getWarningThresholdMB()).toBeGreaterThan(0);
  });
});

describe('memoryProfiler — recordCheckComplete', () => {
  it('returns a profile with rounded numbers and recorded violation count', () => {
    const before = memoryProfiler.recordCheckStart();
    const profile = memoryProfiler.recordCheckComplete('check-A', before, 7, 123);
    expect(profile.checkId).toBe('check-A');
    expect(profile.violationCount).toBe(7);
    expect(profile.durationMs).toBe(123);
    // memoryDeltaMB rounded to 2 decimals — i.e., last fractional digit can be 0 or up to 99
    expect(Number.isFinite(profile.memoryDeltaMB)).toBe(true);
    expect(profile.memoryAfterMB).toBeGreaterThan(0);
  });

  it('records the profile in the summary', () => {
    const before = memoryProfiler.recordCheckStart();
    memoryProfiler.recordCheckComplete('first', before, 1, 10);
    memoryProfiler.recordCheckComplete('second', before, 2, 20);
    const summary = memoryProfiler.getSummary();
    expect(summary.allProfiles).toHaveLength(2);
  });
});

describe('memoryProfiler — exceedsThreshold', () => {
  it('returns false for deltas below the threshold', () => {
    expect(memoryProfiler.exceedsThreshold(0)).toBe(false);
    expect(memoryProfiler.exceedsThreshold(50)).toBe(false);
  });

  it('returns true for deltas above the threshold', () => {
    const threshold = memoryProfiler.getWarningThresholdMB();
    expect(memoryProfiler.exceedsThreshold(threshold + 1)).toBe(true);
  });
});

describe('memoryProfiler — getSummary', () => {
  it('returns an empty summary after reset', () => {
    memoryProfiler.reset();
    const summary = memoryProfiler.getSummary();
    expect(summary.allProfiles).toEqual([]);
    expect(summary.topConsumers).toEqual([]);
    expect(summary.checksExceedingThreshold).toBe(0);
    expect(summary.peakMemoryMB).toBe(0);
    expect(summary.prewarmMemoryMB).toBe(0);
  });

  it('records prewarm baseline when recordPrewarmComplete is called', () => {
    memoryProfiler.recordPrewarmComplete();
    const summary = memoryProfiler.getSummary();
    expect(summary.prewarmMemoryMB).toBeGreaterThan(0);
    expect(summary.peakMemoryMB).toBeGreaterThan(0);
  });

  it('returns at most 10 top consumers, sorted by delta descending', () => {
    const before = memoryProfiler.recordCheckStart();
    for (let i = 0; i < 12; i++) {
      memoryProfiler.recordCheckComplete(`c${i}`, before, i, 5);
    }
    const summary = memoryProfiler.getSummary();
    expect(summary.allProfiles).toHaveLength(12);
    expect(summary.topConsumers.length).toBeLessThanOrEqual(10);
    // Sorted by memoryDeltaMB descending
    for (let i = 1; i < summary.topConsumers.length; i++) {
      const prev = summary.topConsumers[i - 1]?.memoryDeltaMB ?? 0;
      const curr = summary.topConsumers[i]?.memoryDeltaMB ?? 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('counts profiles above the threshold', () => {
    const threshold = memoryProfiler.getWarningThresholdMB();
    // Forge profiles by passing a very low memoryBefore to inflate the delta
    memoryProfiler.recordCheckComplete('hot-1', -threshold * 2, 0, 10);
    memoryProfiler.recordCheckComplete('hot-2', -threshold * 2, 0, 10);
    memoryProfiler.recordCheckComplete('cool', memoryProfiler.getCurrentMemoryMB(), 0, 10);
    const summary = memoryProfiler.getSummary();
    expect(summary.checksExceedingThreshold).toBeGreaterThanOrEqual(2);
  });
});

describe('memoryProfiler — reset', () => {
  it('clears profiles and prewarm/peak baselines', () => {
    memoryProfiler.recordPrewarmComplete();
    memoryProfiler.recordCheckComplete('x', 0, 0, 1);
    memoryProfiler.reset();
    const summary = memoryProfiler.getSummary();
    expect(summary.allProfiles).toEqual([]);
    expect(summary.prewarmMemoryMB).toBe(0);
    expect(summary.peakMemoryMB).toBe(0);
  });
});

describe('memoryProfiler — RunScope isolation', () => {
  it('concurrent scopes carry independent profiler instances', async () => {
    const scopeA = new RunScope();
    const scopeB = new RunScope();
    applyToolContributeScope(scopeA, fitnessTool);
    applyToolContributeScope(scopeB, fitnessTool);

    const [summaryA, summaryB] = await Promise.all([
      runWithScope(scopeA, async () => {
        const profiler = scopeA.fitness!.memoryProfiler;
        profiler.recordCheckComplete('scope-a-check', 0, 0, 1);
        return profiler.getSummary();
      }),
      runWithScope(scopeB, async () => {
        const profiler = scopeB.fitness!.memoryProfiler;
        profiler.recordCheckComplete('scope-b-one', 0, 0, 1);
        profiler.recordCheckComplete('scope-b-two', 0, 0, 1);
        return profiler.getSummary();
      }),
    ]);

    expect(summaryA.allProfiles).toHaveLength(1);
    expect(summaryA.allProfiles[0]?.checkId).toBe('scope-a-check');
    expect(summaryB.allProfiles).toHaveLength(2);
    expect(scopeA.fitness!.memoryProfiler).not.toBe(scopeB.fitness!.memoryProfiler);
  });

  it('scope dispose resets the contributed profiler', () => {
    const scope = new RunScope();
    applyToolContributeScope(scope, fitnessTool);
    const profiler = scope.fitness!.memoryProfiler;
    profiler.recordCheckComplete('disposed-check', 0, 0, 1);
    scope.dispose();
    expect(profiler.getSummary().allProfiles).toEqual([]);
  });
});
