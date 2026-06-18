/**
 * DiagnosticsBus — the scope-owned collector that gathers {@link DiagnosticEvent}s
 * across the uniform tool lifecycle and snapshots them as {@link RunDiagnostics}
 * to ride on a `CommandOutcome` (north-star §5.10, launch).
 *
 * Per-invocation state, held on {@link RunScope} (the no-module-singleton rule):
 * library code deep in the call tree emits via `currentScope()?.diagnostics`, and
 * the host assembler attaches `scope.diagnostics.snapshot()` to every outcome.
 * Additive — the logger, runId, and graph OTEL spans stay; this is the
 * structured, JSON-emittable layer on top.
 *
 * The bus is a runtime collector (like the logger), so it stamps wall-clock time
 * (`new Date().toISOString()`) — the `Date.now()`-free contract applies to the
 * pure formatters (`buildSignalEnvelope`), not to this collector. The OTEL trace
 * bridge is best-effort: `snapshot().trace` carries the active span's
 * trace/span ids when telemetry is on, parsed from the W3C `traceparent` the
 * kernel already exposes — so bundled and external tools are observable
 * identically, with no SDK dependency in the kernel.
 */

import { currentTraceparent } from './telemetry.js';

import type { RunCorrelation } from './run-correlation.js';
import type {
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticPhase,
  RunDiagnostics,
} from './run-diagnostics.js';

/**
 * The correlation join keys an {@link DiagnosticsBus.emitSubprocessEvent} call
 * stamps into the event `data` bag — the subset of {@link RunCorrelation} that
 * lets an operator pivot a `subprocess.spawn|complete|failed` milestone to its
 * run, trace, shard, and worker kind (spec Phase 3 step 1 / GAP d).
 */
export type SubprocessEventCorrelation = Pick<
  RunCorrelation,
  'runId' | 'tool' | 'parentCommand' | 'traceId' | 'shardId' | 'workerKind'
>;

/** A diagnostic event with the timestamp left to the bus to stamp. */
export type DiagnosticEventInput = Omit<DiagnosticEvent, 'at'> & {
  readonly at?: string;
};

/**
 * Parse the `traceId` / `spanId` out of a W3C `traceparent`
 * (`version-traceid-spanid-flags`). Returns `undefined` when telemetry is off
 * (no active recording span → no traceparent) or the string is malformed.
 */
function parseTrace(): { readonly traceId?: string; readonly spanId?: string } | undefined {
  const traceparent = currentTraceparent();
  if (traceparent === undefined) return undefined;
  const parts = traceparent.split('-');
  if (parts.length < 4) return undefined;
  return { traceId: parts[1], spanId: parts[2] };
}

/**
 * The per-invocation diagnostics collector. Construct one per {@link RunScope}.
 */
export class DiagnosticsBus {
  private readonly events: DiagnosticEvent[] = [];
  private readonly metrics = new Map<string, number>();

  constructor(private readonly runId: string) {}

  /**
   * Append a lifecycle event. The bus stamps `at` (ISO-8601) when the caller did
   * not supply one. Cheap and allocation-light; safe to call from any phase.
   */
  emit(event: DiagnosticEventInput): void {
    this.events.push({ ...event, at: event.at ?? new Date().toISOString() });
  }

  /** Convenience: emit at a given phase/level with an optional data bag. */
  event(
    phase: DiagnosticPhase,
    level: DiagnosticLevel,
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ): void {
    this.emit(data === undefined ? { phase, level, message } : { phase, level, message, data });
  }

  /**
   * Convenience: emit a subprocess milestone (`subprocess.spawn|complete|failed`,
   * spec Phase 3 step 1) with the correlation join keys stamped uniformly into
   * the event `data` bag. Builds `{ ...correlation (omitting undefined), ...data }`
   * and delegates to {@link event}, so a milestone lands in the same `events[]`
   * the snapshot copies — no new sink. A `--json` consumer reads
   * `outcome.diagnostics.events` and filters by `data.shardId` / `data.workerKind`.
   *
   * The `traceId` carried in `data` is a PER-EVENT pivot key (GAP d): it
   * complements — does not replace — the bus's own `snapshot().trace` bridge, so
   * an operator can jump from any one milestone to its trace.
   *
   * Bounded by O(shards): a fixed, small number of subprocess events per run,
   * capped by the spawn/fork concurrency (spec Phase 3 step 4 / GAP c) — so no
   * eviction is needed.
   */
  emitSubprocessEvent(
    phase: DiagnosticPhase,
    level: DiagnosticLevel,
    message: string,
    // `Partial`: the shard (spawn) path passes a full `RunCorrelation`; the fork
    // path passes the subset it knows (`runId`/`traceId` may be absent without a
    // scope, `tool`/`parentCommand` come from the optional descriptor bag). Absent
    // fields are omitted from the stamped `data` below — no empty sentinels.
    correlation: Partial<SubprocessEventCorrelation>,
    data?: Record<string, unknown>,
  ): void {
    const mergedData: Record<string, unknown> = {};
    // Stamp the correlation join keys, omitting undefined (no empty sentinels).
    for (const [key, value] of Object.entries(correlation)) {
      if (value !== undefined) mergedData[key] = value;
    }
    if (data !== undefined) Object.assign(mergedData, data);
    this.event(phase, level, message, mergedData);
  }

  /** Increment a named counter (e.g. `'plugins.loaded'`). Defaults to +1. */
  counter(name: string, delta = 1): void {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + delta);
  }

  /**
   * Materialize the JSON-emittable snapshot carried on a `CommandOutcome`. Pure
   * read: copies the event stream + metrics and bridges the active OTEL trace.
   */
  snapshot(): RunDiagnostics {
    const trace = parseTrace();
    return {
      runId: this.runId,
      events: [...this.events],
      ...(this.metrics.size > 0 ? { metrics: Object.fromEntries(this.metrics) } : {}),
      ...(trace ? { trace } : {}),
    };
  }
}
