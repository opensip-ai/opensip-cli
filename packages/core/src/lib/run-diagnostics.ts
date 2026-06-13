/**
 * RunDiagnostics — the shared, JSON-emittable diagnostics shape carried on a
 * {@link CommandOutcome} (north-star §5.10, launch).
 *
 * Today observability is per-subsystem: graph has OTEL spans, fitness has rich
 * callbacks, sim has simple progress, and the bootstrap writes loose log lines.
 * There is no common vocabulary a machine consumer can read. `RunDiagnostics` is
 * that vocabulary: one structured event stream spanning the uniform tool
 * lifecycle (discover → load → validate → execute → render → deliver → persist),
 * a flat metrics-counter map, and a thin bridge to the existing OTEL trace
 * context.
 *
 * The currency is deliberately **minimal-but-extensible** for launch (spec
 * decision): one `DiagnosticEvent` per lifecycle boundary that already exists,
 * not a metrics/timer rebuild. The `metrics`/`trace` slots are reserved so later
 * releases can enrich them without another outer-shape break.
 *
 * Serialization-safe by construction: every field is a primitive, a readonly
 * array of primitives/records, or a plain record — no functions, no class
 * instances, no clock captured here. The producer (the scope-owned diagnostics
 * bus, `@opensip-cli/core`) stamps `at` at the emit site; this layer stays
 * pure (the formatter-purity contract that `SignalEnvelope` also honours).
 */

/**
 * The seven phases of the uniform tool lifecycle (north-star §5.6 / Figure 5),
 * used to tag every {@link DiagnosticEvent}. A consumer can filter the stream by
 * phase to answer "what happened during config load?" or "did delivery run?".
 */
export type DiagnosticPhase =
  | 'discover'
  | 'load'
  | 'validate'
  | 'execute'
  | 'render'
  | 'deliver'
  | 'persist';

/** Severity of a single diagnostic event. Independent of signal severity. */
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * One structured diagnostics event. `at` is an ISO-8601 timestamp supplied by
 * the emitter (core stays `Date.now()`-free in its pure paths; the bus owns the
 * clock). `data` is an optional bag of JSON-safe extras (e.g. which plugin
 * loaded, how many checks matched) — never functions or class instances.
 */
export interface DiagnosticEvent {
  readonly phase: DiagnosticPhase;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly at: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The diagnostics snapshot carried on every {@link CommandOutcome}.
 *
 * - `runId` correlates the snapshot with the invocation's logger/runId.
 * - `events` is the ordered lifecycle stream.
 * - `metrics` is a flat counter map (e.g. `{ 'plugins.loaded': 3 }`); reserved
 *   and populated emit-site-by-emit-site as counters are needed.
 * - `trace` bridges to the existing OTEL span context when telemetry is on
 *   (`OTEL_EXPORTER_OTLP_ENDPOINT` set); absent otherwise.
 */
export interface RunDiagnostics {
  readonly runId: string;
  readonly events: readonly DiagnosticEvent[];
  readonly metrics?: Readonly<Record<string, number>>;
  readonly trace?: {
    readonly traceId?: string;
    readonly spanId?: string;
  };
}
