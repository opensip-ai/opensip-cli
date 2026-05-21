/**
 * Unit tests for the V8 pressure monitor.
 *
 * We can't reliably push the real V8 heap over the threshold in a unit
 * test, so we exercise the monitor by varying its threshold instead.
 * With threshold near 0, any non-empty heap trips it; with threshold
 * 1.0, nothing does. This pins the comparison direction (used / limit)
 * and the dispose contract.
 */

import { describe, it, expect } from 'vitest';

import { createPressureMonitor, MemoryPressureError } from '../../cli/pressure-monitor.js';

describe('createPressureMonitor', () => {
  it('throws MemoryPressureError when threshold is exceeded', () => {
    const monitor = createPressureMonitor({ threshold: 0, pollIntervalMs: 0 });
    monitor.setStage('test-stage');
    try {
      expect(() => monitor.check()).toThrow(MemoryPressureError);
    } finally {
      monitor.dispose();
    }
  });

  it('attaches the bound stage name to the thrown error', () => {
    const monitor = createPressureMonitor({ threshold: 0, pollIntervalMs: 0 });
    monitor.setStage('walk');
    try {
      try {
        monitor.check();
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryPressureError);
        expect((error as MemoryPressureError).stage).toBe('walk');
      }
    } finally {
      monitor.dispose();
    }
  });

  it('does not throw when threshold is unreachable', () => {
    const monitor = createPressureMonitor({ threshold: 1, pollIntervalMs: 0 });
    try {
      expect(() => monitor.check()).not.toThrow();
    } finally {
      monitor.dispose();
    }
  });

  it('respects OPENSIP_HEAP_NO_MONITOR=1 escape hatch', () => {
    const prev = process.env.OPENSIP_HEAP_NO_MONITOR;
    process.env.OPENSIP_HEAP_NO_MONITOR = '1';
    try {
      const monitor = createPressureMonitor({ threshold: 0, pollIntervalMs: 0 });
      expect(() => monitor.check()).not.toThrow();
      monitor.dispose();
    } finally {
      if (prev === undefined) {
        delete process.env.OPENSIP_HEAP_NO_MONITOR;
      } else {
        process.env.OPENSIP_HEAP_NO_MONITOR = prev;
      }
    }
  });

  it('dispose is idempotent', () => {
    const monitor = createPressureMonitor({ threshold: 1 });
    monitor.dispose();
    expect(() => monitor.dispose()).not.toThrow();
  });

  it('re-throws the same error on a subsequent check after a trip', () => {
    const monitor = createPressureMonitor({ threshold: 0, pollIntervalMs: 0 });
    try {
      let first: unknown;
      try {
        monitor.check();
      } catch (error) {
        first = error;
      }
      let second: unknown;
      try {
        monitor.check();
      } catch (error) {
        second = error;
      }
      expect(first).toBe(second);
    } finally {
      monitor.dispose();
    }
  });
});
