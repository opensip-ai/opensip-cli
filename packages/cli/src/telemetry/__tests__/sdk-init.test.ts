import { TimeoutError, logger } from '@opensip-cli/core';
import { trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTelemetry,
  parentTelemetryContext,
  raceWithTimeout,
  resetTelemetryForTests,
  runWithTelemetryContext,
  shutdownTelemetry,
  warnIfInsecureOtlpEndpoint,
} from '../sdk-init.js';

/**
 * Tests for the CLI's env-gated OTel SDK init. Asserts the opt-in gate, single
 * idempotent registration, TRACEPARENT extraction → parent-context nesting, and
 * that shutdown resolves in both modes.
 *
 * The OTel global tracer provider is process-wide, so each test restores both
 * `process.env` and the global provider (`trace.disable()` +
 * `resetTelemetryForTests()`) in afterEach to avoid cross-test bleed.
 */
const ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const TRACEPARENT = 'TRACEPARENT';
// Any import.meta.url-shaped string works; readPackageVersion tolerates misses.
const CLI_ENTRY = import.meta.url;

/**
 * Whether a real SDK provider is globally registered. The OTel API always
 * returns a `ProxyTracerProvider`, so the meaningful signal is whether a
 * freshly started span actually records (no-op tracer ⇒ non-recording).
 */
function spanIsRecording(): boolean {
  let recording = false;
  trace.getTracer('probe').startActiveSpan('probe', (span) => {
    recording = span.isRecording();
    span.end();
  });
  return recording;
}

describe('telemetry SDK init (opt-in gate)', () => {
  let savedEndpoint: string | undefined;
  let savedTraceparent: string | undefined;

  beforeEach(() => {
    savedEndpoint = process.env[ENDPOINT];
    savedTraceparent = process.env[TRACEPARENT];
    delete process.env[ENDPOINT];
    delete process.env[TRACEPARENT];
    resetTelemetryForTests();
    trace.disable();
  });

  afterEach(async () => {
    await shutdownTelemetry();
    resetTelemetryForTests();
    trace.disable();
    if (savedEndpoint === undefined) delete process.env[ENDPOINT];
    else process.env[ENDPOINT] = savedEndpoint;
    if (savedTraceparent === undefined) delete process.env[TRACEPARENT];
    else process.env[TRACEPARENT] = savedTraceparent;
  });

  it('is a hard no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset (no provider registered)', () => {
    initTelemetry(CLI_ENTRY);
    // No real provider ⇒ the no-op tracer produces non-recording spans.
    expect(spanIsRecording()).toBe(false);
    expect(parentTelemetryContext()).toBeUndefined();
  });

  it('registers a real provider exactly once when the endpoint is set', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    initTelemetry(CLI_ENTRY);
    // A real SDK provider is registered ⇒ spans record.
    expect(spanIsRecording()).toBe(true);
  });

  it('is idempotent — a second call does not re-register or throw', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    initTelemetry(CLI_ENTRY);
    // The proxy delegates to the real provider; capture it to prove the second
    // init does not swap in a new one.
    const proxy = trace.getTracerProvider() as { getDelegate: () => unknown };
    const delegateAfterFirst = proxy.getDelegate();
    initTelemetry(CLI_ENTRY);
    expect(proxy.getDelegate()).toBe(delegateAfterFirst);
  });

  it('extracts TRACEPARENT into a parent context so the run nests under it', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    process.env[TRACEPARENT] = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    initTelemetry(CLI_ENTRY);

    const parent = parentTelemetryContext();
    expect(parent).toBeDefined();

    // Inside runWithTelemetryContext, a freshly started span inherits the
    // parent's trace id.
    let observedTraceId: string | undefined;
    runWithTelemetryContext(() => {
      trace.getTracer('test').startActiveSpan('child', (span) => {
        observedTraceId = span.spanContext().traceId;
        span.end();
      });
    });
    expect(observedTraceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('forms its own trace when TRACEPARENT is unset (no parent context)', () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    initTelemetry(CLI_ENTRY);
    expect(parentTelemetryContext()).toBeUndefined();
    // runWithTelemetryContext is a plain pass-through with no parent.
    expect(runWithTelemetryContext(() => 7)).toBe(7);
  });

  it('shutdownTelemetry resolves when telemetry was never started (no-op)', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('shutdownTelemetry resolves after a real init (flushes without throwing)', async () => {
    process.env[ENDPOINT] = 'http://localhost:4318/v1/traces';
    initTelemetry(CLI_ENTRY);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('raceWithTimeout (fail-safe shutdown bound)', () => {
  it('resolves when the work settles before the deadline', async () => {
    await expect(raceWithTimeout(Promise.resolve(), 1000)).resolves.toBeUndefined();
  });

  it('rejects with TimeoutError when the work outlives the deadline (never hangs)', async () => {
    // A flush that never settles — the deadline must win so the CLI exits.
    const neverSettles = new Promise<void>(() => {
      /* intentionally pending */
    });
    await expect(raceWithTimeout(neverSettles, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('warnIfInsecureOtlpEndpoint', () => {
  it('warns for a remote plaintext http endpoint (identity may egress unencrypted)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    warnIfInsecureOtlpEndpoint('http://collector.example.com:4318/v1/traces');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([
    ['https remote', 'https://collector.example.com/v1/traces'],
    ['loopback localhost', 'http://localhost:4318/v1/traces'],
    ['loopback 127.0.0.1', 'http://127.0.0.1:4318'],
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- IPv6 loopback test fixture: exercises the ::1 exemption in the helper.
    ['loopback ::1', 'http://[::1]:4318'],
    ['malformed url', 'not a url'],
  ])('does not warn for %s', (_label, endpoint) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    warnIfInsecureOtlpEndpoint(endpoint);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
