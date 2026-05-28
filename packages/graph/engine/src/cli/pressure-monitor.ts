/**
 * V8 heap pressure monitor.
 *
 * Polls `v8.getHeapStatistics()` to catch impending OOMs before V8
 * itself SIGABRTs the process. The orchestrator calls `check()` at
 * every stage boundary; for long-running stages the monitor also
 * self-polls on a 1s interval. When old-gen usage crosses the
 * configured fraction of the heap limit, `check()` throws
 * `MemoryPressureError` and the orchestrator surfaces it through the
 * normal error path.
 *
 * The 0.90 default leaves ~10% of headroom for V8 to complete one
 * last major GC and for the exception to propagate. Below 0.85 we'd
 * get false positives during normal GC churn; above 0.95 the bail-out
 * itself runs out of headroom.
 */

import v8 from 'node:v8';

import { ToolError } from '@opensip-tools/core';

import type { ToolErrorOptions } from '@opensip-tools/core';

const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export class MemoryPressureError extends ToolError {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly stage: string;

  constructor(
    message: string,
    details: { usedBytes: number; limitBytes: number; stage: string },
    options?: ToolErrorOptions,
  ) {
    super(message, options?.code ?? 'MEMORY_PRESSURE', options);
    this.name = 'MemoryPressureError';
    this.usedBytes = details.usedBytes;
    this.limitBytes = details.limitBytes;
    this.stage = details.stage;
  }
}

export interface PressureMonitorOptions {
  /** Fraction of `heap_size_limit` above which we abort. Default 0.90. */
  readonly threshold?: number;
  /** Background poll interval. 0 disables polling (check-only mode). */
  readonly pollIntervalMs?: number;
}

export interface PressureMonitor {
  /**
   * Bind the monitor to a logical stage. Subsequent `check()` calls and
   * background polls report this stage in any thrown error.
   */
  readonly setStage: (stage: string) => void;
  /** Synchronous check — throws MemoryPressureError if over threshold. */
  readonly check: () => void;
  /** Stop the background poller. Safe to call multiple times. */
  readonly dispose: () => void;
}

/**
 * Create a pressure monitor. Disabled when `OPENSIP_HEAP_NO_MONITOR=1`
 * — gives users an escape hatch for false positives in unusual GC
 * scenarios (REPL embedding, custom allocators).
 */
export function createPressureMonitor(opts: PressureMonitorOptions = {}): PressureMonitor {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const disabled = process.env.OPENSIP_HEAP_NO_MONITOR === '1';
  let stage = 'unknown';
  let timerId: NodeJS.Timeout | null = null;
  let lastError: MemoryPressureError | null = null;

  const evaluate = (): void => {
    if (disabled) return;
    const stats = v8.getHeapStatistics();
    const ratio = stats.total_heap_size / stats.heap_size_limit;
    if (ratio < threshold) return;
    lastError = new MemoryPressureError(
      formatMessage(stage, stats.total_heap_size, stats.heap_size_limit),
      {
        usedBytes: stats.total_heap_size,
        limitBytes: stats.heap_size_limit,
        stage,
      },
    );
  };

  // @fitness-ignore-next-line throws-documentation -- closure throws MemoryPressureError when heap usage crosses the limit ratio (lastError cache or fresh evaluate()); JSDoc cannot attach to a const-arrow
  const check = (): void => {
    const tripped = lastError;
    if (tripped instanceof MemoryPressureError) throw tripped;
    evaluate();
    const tripped2 = lastError;
    if (tripped2 instanceof MemoryPressureError) throw tripped2;
  };

  if (!disabled && pollIntervalMs > 0) {
    timerId = setInterval(evaluate, pollIntervalMs);
    timerId.unref?.();
  }

  return {
    setStage: (s) => {
      stage = s;
    },
    check,
    dispose: () => {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  };
}

const BYTES_PER_GB = 1024 * 1024 * 1024;

function formatMessage(stage: string, usedBytes: number, limitBytes: number): string {
  const usedGb = (usedBytes / BYTES_PER_GB).toFixed(2);
  const limitGb = (limitBytes / BYTES_PER_GB).toFixed(2);
  return (
    `Heap headroom exhausted at stage "${stage}" (used ${usedGb} GB of ${limitGb} GB cap). ` +
    `Aborted before V8 OOM. Try \`opensip-tools graph --package <name>\` to scope to a single ` +
    `workspace package, or \`--packages\` to fan out per-package (each child gets its own heap).`
  );
}
