/**
 * @fileoverview Coverage gap-fillers for small utility surfaces.
 *
 * Each test here targets a real-world failure or behavior, not just
 * raw line coverage. Concretely:
 *   - core's Registry<T> name-collision guard (with nameCollisionMode:
 *     'throw') prevents inconsistent dual-key state when two different
 *     ids share a name — without the throw, the last writer wins on
 *     `byName` while both ids remain in `byId`. This is the contract
 *     the simulation scenario registry depends on.
 *   - LatencyTracker's reset() must clear the running sum, otherwise a
 *     subsequent record() would carry stale state.
 *   - renderScenarioResultView's exhaustiveness branch fires when an
 *     unknown `kind` reaches the renderer; tests force this with a
 *     hand-rolled cast to verify the runtime guard, not just the types.
 */

import { Registry, type Registerable, ValidationError } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { LatencyTracker } from '../execution/latency-tracker.js';
import { renderScenarioResultView } from '../result-renderers.js';

import type { ScenarioExecutorResult } from '../scenario-executor-result.js';

// ---------------------------------------------------------------------------
// Registry<T> with silent-skip + nameCollisionMode='throw' (the
// shape simulation scenario registry uses)
// ---------------------------------------------------------------------------

interface TestItem extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

function makeScenarioRegistry(): Registry<TestItem> {
  return new Registry<TestItem>({
    module: 'test',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'test.registry',
    nameCollisionMode: 'throw',
  });
}

describe('Registry<T> with silent-skip + nameCollisionMode=throw — coverage edges', () => {
  it('throws ValidationError on a name collision (two different ids, same name)', () => {
    const reg = makeScenarioRegistry();
    reg.register({ id: 'a', name: 'shared' });

    expect(() => reg.register({ id: 'b', name: 'shared' })).toThrow(ValidationError);
  });

  it('skips silent duplicate when same id is registered twice', () => {
    const reg = makeScenarioRegistry();
    reg.register({ id: 'a', name: 'one' });
    reg.register({ id: 'a', name: 'one' }); // skipped silently
    expect(reg.size).toBe(1);
  });

  it('size() reflects current entries', () => {
    const reg = makeScenarioRegistry();
    expect(reg.size).toBe(0);
    reg.register({ id: 'a', name: 'one' });
    reg.register({ id: 'b', name: 'two' });
    expect(reg.size).toBe(2);
  });

  it('clear() empties both byId and byName indices', () => {
    const reg = makeScenarioRegistry();
    reg.register({ id: 'a', name: 'one' });
    reg.register({ id: 'b', name: 'two', tags: ['x'] });
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.get('a')).toBeUndefined();
    expect(reg.get('one')).toBeUndefined();
    expect(reg.getByTag('x')).toEqual([]);
  });

  it('getByTag returns matching items', () => {
    const reg = makeScenarioRegistry();
    reg.register({ id: 'a', name: 'one', tags: ['x', 'shared'] });
    reg.register({ id: 'b', name: 'two', tags: ['shared'] });
    reg.register({ id: 'c', name: 'three' });
    const shared = reg.getByTag('shared');
    expect(shared.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// LatencyTracker — reset() and average() with no samples
// ---------------------------------------------------------------------------

describe('LatencyTracker — reset and zero-sample edges', () => {
  it('reset() clears samples, sum, and the sorted cache', () => {
    const t = new LatencyTracker();
    t.record(10);
    t.record(20);
    t.record(30);
    expect(t.average).toBeCloseTo(20);
    expect(t.count).toBe(3);

    t.reset();
    expect(t.count).toBe(0);
    expect(t.average).toBe(0);
    expect(t.getPercentile(50)).toBe(0);

    // After reset, new samples behave as if fresh.
    t.record(100);
    expect(t.average).toBe(100);
    expect(t.count).toBe(1);
  });

  it('average() returns 0 with no samples', () => {
    const t = new LatencyTracker();
    expect(t.average).toBe(0);
  });

  it('getPercentile returns the single sample with one record', () => {
    const t = new LatencyTracker();
    t.record(42);
    expect(t.getPercentile(50)).toBe(42);
    expect(t.getPercentile(99)).toBe(42);
  });

  it('getPercentile interpolates linearly between bracketing samples', () => {
    const t = new LatencyTracker();
    // 4 samples → index for p50 = 0.5 * 3 = 1.5 → interpolate between
    // sorted[1]=20 and sorted[2]=30 with fraction 0.5 → 25.
    t.record(40);
    t.record(20);
    t.record(10);
    t.record(30);
    expect(t.getPercentile(50)).toBeCloseTo(25);
    // p0 and p100 land exactly on the endpoints (lower === upper path).
    expect(t.getPercentile(0)).toBe(10);
    expect(t.getPercentile(100)).toBe(40);
  });

  it('getLatencySnapshot reports avg + percentiles together', () => {
    const t = new LatencyTracker();
    t.record(10);
    t.record(20);
    t.record(30);
    const snap = t.getLatencySnapshot();
    expect(snap.avgLatencyMs).toBeCloseTo(20);
    expect(snap.p50LatencyMs).toBeCloseTo(20);
    expect(snap.p95LatencyMs).toBeGreaterThanOrEqual(snap.p50LatencyMs);
    expect(snap.p99LatencyMs).toBeGreaterThanOrEqual(snap.p95LatencyMs);
  });
});

// ---------------------------------------------------------------------------
// renderScenarioResultView — exhaustiveness guard
// ---------------------------------------------------------------------------

describe('renderScenarioResultView — exhaustiveness guard', () => {
  it('throws when called with an unknown kind (runtime safety net)', () => {
    // Hand-rolled cast — the union doesn't permit "future-kind" at compile
    // time, but the runtime exhaustiveness probe is what protects callers
    // when a future variant slips past the type system (e.g., crossing a
    // serialization boundary).
    const future = {
      kind: 'future-kind',
      scenarioId: 's1',
      passed: true,
      durationMs: 1,
      signals: [],
      outcome: {},
    } as unknown as ScenarioExecutorResult;

    expect(() => renderScenarioResultView(future)).toThrow(/exhaustiveness/);
  });
});
