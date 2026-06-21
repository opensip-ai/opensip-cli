/**
 * OpenTelemetry SDK init — the application half of the OTel library/application
 * split, wired ONLY at the CLI composition root.
 *
 * ## Opt-in gate (the load-bearing contract)
 *
 * The entire SDK (traces + metrics + optional profiling) is gated on
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (see ADR-0049 and observability plan for details).
 *
 *   - **Set** ⇒ register NodeTracerProvider + (Phase 2) MeterProvider.
 *     `core`'s `getTracer`/`withSpan`/`getMeter` resolve to real implementations.
 *   - Profiling uses the same endpoint (recommended with dedicated
 *     `OPENSIP_PROFILING=1` flag for cost control; "OTEL endpoint alone" mode
 *     is supported with warnings).
 *   - **Unset** ⇒ hard no-op for everything. Standalone CLI pays nothing.
 *
 * ## Layering
 *
 * The heavy SDK packages (`@opentelemetry/sdk-trace-node`, the OTLP exporter,
 * `context-async-hooks`, `core`'s propagator, `resources`) are imported HERE
 * and nowhere else. `core` and the tool packages depend on `@opentelemetry/api`
 * only — dependency-cruiser enforces that an `@opentelemetry/sdk-*` import never
 * leaks into the kernel or a tool.
 *
 * ## Parent-trace nesting
 *
 * An embedding consumer spawns the binary with a `TRACEPARENT` env var. We
 * extract it via the W3C propagator and expose it as a parent context
 * ({@link parentTelemetryContext} / {@link runWithTelemetryContext}) so the
 * command dispatch — and therefore graph's stage spans — nests under the
 * consumer's trace. When `TRACEPARENT` is unset the spans form their own trace,
 * which is still valid.
 *
 * ## Fail-safe shutdown
 *
 * Telemetry must never crash OR hang the primary CLI run: a dead/slow collector
 * has to degrade to "spans dropped," not a multi-second stall on exit (amplified
 * on the sharded path, where every shard-worker subprocess also flushes). Two
 * bounds enforce this: each export attempt is capped at {@link SHUTDOWN_TIMEOUT_MS}
 * (`OTLPTraceExporter({ timeoutMillis })`), and {@link shutdownTelemetry} races the
 * final flush against the same deadline and swallows any failure.
 */

import { logger, readPackageVersion, TimeoutError } from '@opensip-cli/core';
import {
  ROOT_CONTEXT,
  context as otelContext,
  defaultTextMapGetter,
  metrics,
  trace,
  type Context,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes, detectResources, envDetector } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import { hostEnv } from '../env/host-env-specs.js';

import { stopProfiling, resetProfilingForTests } from './profiling.js';

/**
 * Hard ceiling (ms) on the final span flush AND on each individual export
 * attempt. A dead/slow collector degrades to "spans dropped," never a hang on
 * CLI or shard-worker exit. Kept short — a few seconds of lost batched spans is
 * a fair trade for never stalling the primary run.
 */
const SHUTDOWN_TIMEOUT_MS = 2000;

/** Idempotency guard — provider registration is process-wide and one-shot. */
let started = false;

/** Internal shared reset of the process-wide telemetry state. */
function resetTelemetryState(): void {
  started = false;
  provider = undefined;
  meterProvider = undefined;
  parentContext = undefined;
}

/** The active tracer provider, retained so {@link shutdownTelemetry} can flush it. */
let provider: NodeTracerProvider | undefined;

/** The active meter provider (Phase 2). */
let meterProvider: MeterProvider | undefined;

/**
 * Parent context extracted from `TRACEPARENT`, or undefined when the var is
 * absent (or telemetry is disabled). {@link runWithTelemetryContext} activates
 * it so spans created during the run nest under the consumer's trace.
 */
let parentContext: Context | undefined;

/**
 * Warn when the OTLP endpoint targets a non-loopback host over plaintext http.
 * Traces can carry identity (`tenant_id`/`run_id` via OTEL_RESOURCE_ATTRIBUTES),
 * so a remote plaintext collector leaks it on the wire — the same risk the cloud
 * signal/report egress refuses outright. Loopback dev collectors
 * (localhost/127.0.0.1/::1) are exempt; https is the fix for remote ones. We warn
 * rather than refuse — telemetry is strictly opt-in. Exported for tests.
 */
export function warnIfInsecureOtlpEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- a malformed endpoint is the exporter's failure to surface; nothing actionable to warn here.
    return;
  }
  // Only plaintext http is the leak we warn on. https is secure; any other scheme
  // (e.g. grpc) is not what the OTLP-http exporter speaks and isn't our concern.
  if (url.protocol !== 'http:') return;
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;
  logger.warn('telemetry.endpoint.insecure', {
    evt: 'telemetry.endpoint.insecure',
    module: 'cli:telemetry',
    endpoint,
    msg: `OTLP endpoint '${endpoint}' uses plaintext ${url.protocol}// to a non-loopback host; traces can carry identity (tenant_id/run_id from OTEL_RESOURCE_ATTRIBUTES) and will egress unencrypted. Use https:// for remote collectors.`,
  });
}

/**
 * Initialize OpenTelemetry tracing, gated on `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * No-op when the endpoint env var is falsy, or when already started (idempotent
 * and safe to call from multiple entry points). Sets the GLOBAL tracer provider
 * so `core`'s `getTracer` resolves to real tracers process-wide.
 *
 * @param cliEntryUrl `import.meta.url` of the CLI entry, used to read the CLI
 *   package version for the `service.version` resource attribute.
 */
export function initTelemetry(cliEntryUrl: string): void {
  if (started) return;
  const endpoint = hostEnv.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (!endpoint) return;
  warnIfInsecureOtlpEndpoint(endpoint);

  // Resource: explicit service identity merged with consumer-supplied
  // attributes from OTEL_RESOURCE_ATTRIBUTES (via the env detector), e.g.
  // `tenant_id=...,run_id=...`.
  const resource = detectResources({ detectors: [envDetector] }).merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'opensip-cli',
      [ATTR_SERVICE_VERSION]: readPackageVersion(cliEntryUrl),
    }),
  );

  provider = new NodeTracerProvider({
    resource,
    // Bound each export attempt so a slow/dead collector fails fast instead of
    // letting the batch processor block the final flush — see SHUTDOWN_TIMEOUT_MS.
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: SHUTDOWN_TIMEOUT_MS })),
    ],
  });

  // register() installs the GLOBAL provider + propagator + context manager,
  // so core's getTracer (Phase 0) resolves to real tracers everywhere.
  provider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: new W3CTraceContextPropagator(),
  });

  // Phase 2: MeterProvider for metrics (same resource + gate).
  // Uses PeriodicExportingMetricReader; for short-lived CLI the interesting
  // export happens on shutdownTelemetry. No-op when gate closed.
  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ timeoutMillis: SHUTDOWN_TIMEOUT_MS }),
        exportIntervalMillis: 5000, // short for CLI; shutdown forces final export
      }),
    ],
  });
  // Register globally so that core's getMeter() (and any tool code using
  // @opentelemetry/api metrics.getMeter) resolves to this provider's meters.
  // Without this, all CLI + tool metrics are silently no-op even when the
  // OTLP endpoint is configured (the reader/exporter wiring is useless if
  // nothing ever creates instruments against the provider).
  metrics.setGlobalMeterProvider(meterProvider);

  // Parent-trace nesting: extract the W3C traceparent the consumer passed via
  // env so the run's spans attach under the parent trace. Unset ⇒ own trace.
  const traceparent = hostEnv.get<string>('TRACEPARENT');
  if (traceparent) {
    parentContext = new W3CTraceContextPropagator().extract(
      ROOT_CONTEXT,
      { traceparent },
      defaultTextMapGetter,
    );
    // Only keep it if it actually yielded a valid span context.
    if (!trace.getSpanContext(parentContext)) parentContext = undefined;
  }

  started = true;
}

/**
 * The parent context extracted from `TRACEPARENT`, or undefined. Exposed for
 * tests; production code should prefer {@link runWithTelemetryContext}.
 */
export function parentTelemetryContext(): Context | undefined {
  return parentContext;
}

/**
 * Run `fn` with the extracted parent context active (when present), so spans
 * created inside nest under the consumer's trace. A plain pass-through when no
 * parent context was extracted (or telemetry is disabled), so standalone runs
 * pay nothing.
 */
export function runWithTelemetryContext<T>(fn: () => T): T {
  return parentContext ? otelContext.with(parentContext, fn) : fn();
}

/**
 * Flush and shut down the tracer + meter providers (and stop profiling if active)
 * so batched data export before the short-lived process exits.
 * No-op when telemetry was never started. Swallows shutdown errors — a dead
 * collector must not crash the CLI on the way out.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!started) return;

  // Stop profiling first (it may write files and is cheap).
  try {
    void stopProfiling();
  } catch {
    // @swallow-ok best-effort profiling stop during SDK shutdown
  }

  const shutdowns: Promise<void>[] = [];

  if (provider) {
    shutdowns.push(
      raceWithTimeout(provider.shutdown(), SHUTDOWN_TIMEOUT_MS).catch((error) => {
        logger.warn('telemetry.shutdown.failed', {
          evt: 'telemetry.shutdown.failed',
          module: 'cli:telemetry',
          kind: 'tracer',
          err: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  if (meterProvider) {
    shutdowns.push(
      raceWithTimeout(meterProvider.shutdown(), SHUTDOWN_TIMEOUT_MS).catch((error) => {
        logger.warn('telemetry.shutdown.failed', {
          evt: 'telemetry.shutdown.failed',
          module: 'cli:telemetry',
          kind: 'meter',
          err: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  if (shutdowns.length > 0) {
    await Promise.all(shutdowns);
  }
}

/**
 * Resolve when `work` settles, or reject with {@link TimeoutError} after `ms` —
 * whichever comes first. The deadline timer is `unref`'d so it never keeps the
 * (short-lived CLI) event loop alive when the work wins, and cleared on the
 * happy path. Exported for tests.
 */
export async function raceWithTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`telemetry shutdown exceeded ${String(ms)}ms`)),
          ms,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Test-only reset of module state. Production never calls this — the CLI is a
 * one-shot process. Tests use it to exercise the gate across env permutations
 * without a fresh module each time.
 */
export function resetTelemetryForTests(): void {
  resetTelemetryState();
  resetProfilingForTests();
}
