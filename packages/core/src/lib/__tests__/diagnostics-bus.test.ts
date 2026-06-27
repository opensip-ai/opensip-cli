/**
 * DiagnosticsBus — event ordering, timestamp stamping, counters, JSON-safety, and
 * the empty-run snapshot. The OTEL trace bridge is `undefined` here (no SDK
 * registered in the test process), which is the standalone-run contract.
 */

import { describe, it, expect, vi } from 'vitest';

import { DiagnosticsBus } from '../diagnostics-bus.js';
import * as telemetry from '../telemetry.js';

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
    bus.emit({
      phase: 'validate',
      level: 'warn',
      message: 'x',
      at: '2026-06-07T00:00:00.000Z',
    });
    expect(bus.snapshot().events[0].at).toBe('2026-06-07T00:00:00.000Z');
  });

  it('bridges the active traceparent into snapshot().trace when telemetry is on', () => {
    const spy = vi
      .spyOn(telemetry, 'currentTraceparent')
      .mockReturnValue('00-abc123def456789012345678901234-9876543210abcdef-01');
    const snap = new DiagnosticsBus('run_trace').snapshot();
    expect(snap.trace).toEqual({
      traceId: 'abc123def456789012345678901234',
      spanId: '9876543210abcdef',
    });
    spy.mockRestore();
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

  describe('emitSubprocessEvent', () => {
    it('stamps the correlation join keys into the event data bag, merged with extras', () => {
      const bus = new DiagnosticsBus('run_6');
      bus.emitSubprocessEvent(
        'load',
        'debug',
        'subprocess.spawn',
        {
          runId: 'run_6',
          tool: 'graph',
          parentCommand: 'graph',
          traceId: '00-abc-def-01',
          shardId: 's-1',
          workerKind: 'shard',
        },
        { shards: 3, concurrency: 2 },
      );
      const [event] = bus.snapshot().events;
      expect(event.phase).toBe('load');
      expect(event.level).toBe('debug');
      expect(event.message).toBe('subprocess.spawn');
      expect(event.data).toEqual({
        runId: 'run_6',
        tool: 'graph',
        parentCommand: 'graph',
        traceId: '00-abc-def-01',
        shardId: 's-1',
        workerKind: 'shard',
        shards: 3,
        concurrency: 2,
      });
    });

    it('omits undefined correlation fields (no empty sentinels) — e.g. traceId when OTel is off', () => {
      const bus = new DiagnosticsBus('run_7');
      bus.emitSubprocessEvent('load', 'warn', 'subprocess.failed', {
        runId: 'run_7',
        workerKind: 'live-engine',
        traceId: undefined,
      });
      const [event] = bus.snapshot().events;
      expect(event.data).toEqual({ runId: 'run_7', workerKind: 'live-engine' });
      expect(event.data).not.toHaveProperty('traceId');
    });

    it('emits with an empty data bag when no correlation field is present', () => {
      const bus = new DiagnosticsBus('run_8');
      bus.emitSubprocessEvent('load', 'debug', 'subprocess.complete', {});
      const [event] = bus.snapshot().events;
      expect(event.message).toBe('subprocess.complete');
      expect(event.data).toEqual({});
    });

    it('lets a data extra override a correlation key of the same name (data spread last)', () => {
      const bus = new DiagnosticsBus('run_9');
      bus.emitSubprocessEvent(
        'load',
        'warn',
        'subprocess.failed',
        { runId: 'run_9', workerKind: 'shard' },
        { workerKind: 'external-tool' },
      );
      expect(bus.snapshot().events[0].data).toEqual({
        runId: 'run_9',
        workerKind: 'external-tool',
      });
    });
  });
});
