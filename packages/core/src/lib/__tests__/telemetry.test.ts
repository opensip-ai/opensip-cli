import { trace } from '@opentelemetry/api';
import { describe, it, expect, vi } from 'vitest';

import { getTracer, withSpan } from '../../lib/telemetry.js';

/**
 * Kernel-level telemetry tests assert the **no-op-until-SDK contract** — the
 * load-bearing guarantee for standalone users. core carries only
 * `@opentelemetry/api` and NO SDK, so these tests deliberately never register a
 * provider: they prove `withSpan` runs `fn`, returns its value, and emits
 * nothing through the API's no-op tracer.
 *
 * Span-CAPTURE behavior (assertions that a real span is produced with the
 * expected name/attributes) is tested in `@opensip-tools/cli`, where the OTel
 * SDK + InMemorySpanExporter legitimately live. Putting span-capture tests
 * there keeps the SDK out of the kernel — see
 * `packages/cli/src/telemetry/__tests__/`.
 */
describe('telemetry primitive (no-op-until-SDK contract)', () => {
  it('getTracer returns a tracer whose spans are non-recording when no SDK is registered', () => {
    // No provider registered ⇒ the global is the API's no-op tracer.
    expect(trace.getTracerProvider().constructor.name).toMatch(/Noop|Proxy/);
    let recording: boolean | undefined;
    getTracer('test-scope').startActiveSpan('probe', (span) => {
      recording = span.isRecording();
      span.end();
    });
    // The no-op span never records.
    expect(recording).toBe(false);
  });

  it('withSpan runs fn and returns its value with no SDK registered', () => {
    const sentinel = { value: 42 };
    const result = withSpan('test-scope', 'unit', () => sentinel);
    expect(result).toBe(sentinel);
  });

  it('withSpan passes the (no-op) span to fn', () => {
    let received: unknown;
    withSpan('test-scope', 'unit', (span) => {
      received = span;
    });
    expect(received).toBeDefined();
    // It is a span object (has the span surface) even when no-op.
    expect(typeof (received as { end: unknown }).end).toBe('function');
  });

  it('withSpan applies attributes before fn runs (no-op span accepts them without throwing)', () => {
    const setAttributes = vi.fn();
    // Stub the tracer so we can observe attribute application on the no-op path.
    const span = {
      setAttributes,
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
      isRecording: () => false,
    };
    const spy = vi
      .spyOn(trace, 'getTracer')
      .mockReturnValue({
        startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never,
      } as never);
    try {
      withSpan('test-scope', 'unit', () => 'ok', { 'k.count': 3, 'k.flag': true });
      expect(setAttributes).toHaveBeenCalledWith({ 'k.count': 3, 'k.flag': true });
      expect(span.end).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('withSpan records the exception, sets ERROR status, ends the span, and rethrows', () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const span = {
      setAttributes: vi.fn(),
      setStatus,
      recordException,
      end,
      isRecording: () => false,
    };
    const spy = vi
      .spyOn(trace, 'getTracer')
      .mockReturnValue({
        startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never,
      } as never);
    const boom = new Error('boom');
    try {
      expect(() =>
        withSpan('test-scope', 'unit', () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(recordException).toHaveBeenCalledWith(boom);
      // SpanStatusCode.ERROR === 2
      expect(setStatus).toHaveBeenCalledWith({ code: 2 });
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
