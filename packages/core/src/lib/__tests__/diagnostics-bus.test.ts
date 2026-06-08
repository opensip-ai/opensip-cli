/**
 * DiagnosticsBus — event ordering, timestamp stamping, counters, JSON-safety, and
 * the empty-run snapshot. The OTEL trace bridge is `undefined` here (no SDK
 * registered in the test process), which is the standalone-run contract.
 */

import { describe, it, expect } from 'vitest';

import { DiagnosticsBus } from '../diagnostics-bus.js';

describe('DiagnosticsBus', () => {
  it('collects events in order and stamps an ISO timestamp when none is given', () => {
    const bus = new DiagnosticsBus('run_1');
    bus.event('load', 'debug', 'loaded plugins');
    bus.event('execute', 'info', 'ran command');
    const snap = bus.snapshot();
    expect(snap.runId).toBe('run_1');
    expect(snap.events.map((e) => e.message)).toEqual(['loaded plugins', 'ran command']);
    expect(snap.events.map((e) => e.phase)).toEqual(['load', 'execute']);
    // `at` is stamped as a parseable ISO-8601 string.
    expect(Number.isNaN(Date.parse(snap.events[0].at))).toBe(false);
  });

  it('preserves a caller-supplied timestamp', () => {
    const bus = new DiagnosticsBus('run_2');
    bus.emit({ phase: 'validate', level: 'warn', message: 'x', at: '2026-06-07T00:00:00.000Z' });
    expect(bus.snapshot().events[0].at).toBe('2026-06-07T00:00:00.000Z');
  });

  it('accumulates counters and only includes metrics when non-empty', () => {
    const empty = new DiagnosticsBus('run_3').snapshot();
    expect(empty.metrics).toBeUndefined();
    expect(empty.trace).toBeUndefined();
    expect(empty.events).toEqual([]);

    const bus = new DiagnosticsBus('run_4');
    bus.counter('tools.loaded', 3);
    bus.counter('tools.loaded');
    expect(bus.snapshot().metrics).toEqual({ 'tools.loaded': 4 });
  });

  it('carries an optional data bag and round-trips through JSON', () => {
    const bus = new DiagnosticsBus('run_5');
    bus.event('load', 'debug', 'detail', { count: 2 });
    const snap = bus.snapshot();
    const wire = JSON.stringify(snap);
    expect(JSON.parse(wire)).toEqual(snap);
    expect(snap.events[0].data).toEqual({ count: 2 });
  });
});
