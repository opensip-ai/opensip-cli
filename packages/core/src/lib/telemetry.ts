/**
 * Tracing primitive for opensip-tools — the kernel sibling of `logger`.
 *
 * This module is a thin wrapper over the **OpenTelemetry API** (`@opentelemetry/api`)
 * — the no-op facade half of OTel's library/application split. It exposes a
 * narrow tracing seam (`getTracer`, `withSpan`) that every tool uses to emit
 * spans, exactly as every tool emits logs through `logger`.
 *
 * ## No-op-until-SDK contract (load-bearing for standalone users)
 *
 * The OpenTelemetry **API** does nothing on its own. Until an SDK registers a
 * global `TracerProvider`, `trace.getTracer(...)` returns a *no-op tracer*:
 * `startActiveSpan` runs the callback with a no-op span, records nothing, makes
 * no network calls, and adds an unmeasurable amount of overhead. That
 * registration happens ONLY at the application boundary — the CLI composition
 * root (`@opensip-tools/cli`), gated on `OTEL_EXPORTER_OTLP_ENDPOINT`. The heavy
 * SDK packages (`@opentelemetry/sdk-*`, exporters, context managers) never enter
 * the kernel.
 *
 * The consequence: importing and calling `withSpan` from a standalone CLI run
 * (no OTLP endpoint configured) is a hard no-op — `fn` runs, its value is
 * returned, and nothing is emitted. This is the guarantee standalone users
 * depend on, and it is asserted in `__tests__/telemetry.test.ts`.
 */

import { trace, SpanStatusCode, type Span, type Attributes, type Tracer } from '@opentelemetry/api';

/**
 * Resolve a `Tracer` for a given instrumentation scope name (e.g.
 * `'opensip-tools-graph'`). Reads the *global* tracer provider set by the SDK
 * at the application boundary; returns a no-op tracer when no SDK is registered.
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Run `fn` inside an active span.
 *
 * Records exceptions and sets ERROR status if `fn` throws, and always ends the
 * span. When no SDK is registered the underlying tracer is a no-op, so this adds
 * an unmeasurable amount of overhead — see the no-op-until-SDK contract above.
 *
 * Synchronous by design: graph's `runStage` (the first consumer) is synchronous,
 * so `fn` returns `T` and the span ends when the callback returns. An async
 * caller passes an async `fn` and the helper returns its promise — but note the
 * span ends when the synchronous callback returns, so an async caller that wants
 * the span to span the awaited work should `return await fn()` from inside an
 * async `fn` whose promise the helper returns (i.e. `withSpan(name, span, async () => { ... })`).
 *
 * @param tracerName instrumentation scope (passed to {@link getTracer})
 * @param spanName   the span name
 * @param fn         the work to run inside the span
 * @param attrs      optional attributes set on the span before `fn` runs
 */
export function withSpan<T>(
  tracerName: string,
  spanName: string,
  fn: (span: Span) => T,
  attrs?: Attributes,
): T {
  return getTracer(tracerName).startActiveSpan(spanName, (span) => {
    if (attrs) span.setAttributes(attrs);
    try {
      return fn(span);
    } catch (error) {
      // Normalize before recording: a thrown non-Error (string, object) must
      // record as a message rather than be unsafely cast to Error. OTel's
      // `recordException` accepts `string | Exception`, so this is type-safe.
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
