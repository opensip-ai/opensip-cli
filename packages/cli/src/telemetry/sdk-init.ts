/**
 * OpenTelemetry SDK init — the application half of the OTel library/application
 * split, wired ONLY at the CLI composition root.
 *
 * ## Opt-in gate (the load-bearing contract)
 *
 * The entire SDK is gated on `OTEL_EXPORTER_OTLP_ENDPOINT`:
 *
 *   - **Set** ⇒ register a global `NodeTracerProvider` (OTLP/HTTP exporter,
 *     AsyncLocalStorage context manager, W3C TraceContext propagator, resource
 *     attributes). From that point `core`'s `getTracer`/`withSpan` resolve to
 *     real tracers process-wide, so graph's stage spans are emitted.
 *   - **Unset** ⇒ hard no-op: no provider registers, the OTel API stays a
 *     no-op facade, and standalone CLI runs pay nothing. This is the guarantee
 *     standalone users depend on.
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
 * > Hardening note (deferred to manual enrichment): exporter failure must never
 * > crash or hang the CLI. A dead collector should degrade to "no telemetry,"
 * > not a broken run. `shutdownTelemetry` already swallows shutdown errors; the
 * > exporter's own retry/timeout tuning is flagged for the plan-improvements pass.
 */

import { logger, readPackageVersion } from '@opensip-tools/core';
import {
  ROOT_CONTEXT,
  context as otelContext,
  defaultTextMapGetter,
  trace,
  type Context,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes, detectResources, envDetector } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** Idempotency guard — provider registration is process-wide and one-shot. */
let started = false;

/** The active provider, retained so {@link shutdownTelemetry} can flush it. */
let provider: NodeTracerProvider | undefined;

/**
 * Parent context extracted from `TRACEPARENT`, or undefined when the var is
 * absent (or telemetry is disabled). {@link runWithTelemetryContext} activates
 * it so spans created during the run nest under the consumer's trace.
 */
let parentContext: Context | undefined;

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
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  // Resource: explicit service identity merged with consumer-supplied
  // attributes from OTEL_RESOURCE_ATTRIBUTES (via the env detector), e.g.
  // `tenant_id=...,run_id=...`.
  const resource = detectResources({ detectors: [envDetector] }).merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'opensip-tools',
      [ATTR_SERVICE_VERSION]: readPackageVersion(cliEntryUrl),
    }),
  );

  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });

  // register() installs the GLOBAL provider + propagator + context manager,
  // so core's getTracer (Phase 0) resolves to real tracers everywhere.
  provider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: new W3CTraceContextPropagator(),
  });

  // Parent-trace nesting: extract the W3C traceparent the consumer passed via
  // env so the run's spans attach under the parent trace. Unset ⇒ own trace.
  const traceparent = process.env.TRACEPARENT;
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
 * Flush and shut down the tracer provider so batched spans export before the
 * short-lived process exits. No-op when telemetry was never started. Swallows
 * shutdown errors — a dead collector must not crash the CLI on the way out.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!started || !provider) return;
  try {
    await provider.shutdown();
  } catch (error) {
    logger.warn('telemetry.shutdown.failed', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Test-only reset of module state. Production never calls this — the CLI is a
 * one-shot process. Tests use it to exercise the gate across env permutations
 * without a fresh module each time.
 */
export function resetTelemetryForTests(): void {
  started = false;
  provider = undefined;
  parentContext = undefined;
}
