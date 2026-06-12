// @fitness-ignore-file detached-promises -- OTel Span methods (recordException/setStatus/end) return void (sync); the heuristic flags them inside withSpanAsync's async callback. The only promise here (fn(span)) is awaited.
/**
 * Tracing primitive for opensip-cli — the kernel sibling of `logger`.
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
 * root (`opensip-cli`), gated on `OTEL_EXPORTER_OTLP_ENDPOINT`. The heavy
 * SDK packages (`@opentelemetry/sdk-*`, exporters, context managers) never enter
 * the kernel.
 *
 * The consequence: importing and calling `withSpan` from a standalone CLI run
 * (no OTLP endpoint configured) is a hard no-op — `fn` runs, its value is
 * returned, and nothing is emitted. This is the guarantee standalone users
 * depend on, and it is asserted in `__tests__/telemetry.test.ts`.
 */

import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Span,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Resolve a `Tracer` for a given instrumentation scope name (e.g.
 * `'opensip-cli-graph'`). Reads the *global* tracer provider set by the SDK
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

/**
 * Async sibling of {@link withSpan}: the span stays open across awaited work and
 * ends only when the returned promise settles.
 *
 * {@link withSpan} is synchronous — its `finally` runs the instant the callback
 * returns, so wrapping awaited work with it would end the span before the work
 * completes and miss async rejections. Use this for any `fn` that returns a
 * promise. The span stays active for the duration of the awaited work (under the
 * SDK's AsyncLocalStorage context manager), so descendants — including spans
 * emitted by spawned subprocesses that inherit {@link currentTraceparent} — nest
 * under it. Same no-op-until-SDK contract: a hard no-op when no SDK is registered.
 *
 * @param tracerName instrumentation scope (passed to {@link getTracer})
 * @param spanName   the span name
 * @param fn         the async work to run inside the span
 * @param attrs      optional attributes set on the span before `fn` runs
 */
export async function withSpanAsync<T>(
  tracerName: string,
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Attributes,
): Promise<T> {
  return getTracer(tracerName).startActiveSpan(spanName, async (span) => {
    if (attrs) span.setAttributes(attrs);
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Serialize the currently-active span context to a W3C `traceparent` string, for
 * propagation into a spawned subprocess (passed as the `TRACEPARENT` env var,
 * which {@link initTelemetry} extracts at the child's boundary so its spans nest
 * under ours).
 *
 * Returns `undefined` when there is no active recording span — which includes
 * every standalone run, since the no-op tracer produces an invalid (all-zero)
 * span context that the W3C propagator declines to emit. Uses the globally
 * registered propagator (installed by the SDK at the application boundary), so
 * the kernel stays a pure `@opentelemetry/api` consumer with no SDK dependency.
 */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
