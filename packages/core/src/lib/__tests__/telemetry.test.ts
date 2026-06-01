import { trace } from '@opentelemetry/api';
import { describe, it, expect, vi } from 'vitest';

import { currentTraceparent, getTracer, withSpan, withSpanAsync } from '../../lib/telemetry.js';

/**
 * Kernel-level telemetry tests assert the **no-op-until-SDK contract** — the
 * load-bearing guarantee for standalone users. core carries only
 * `@opentelemetry/api` and NO SDK, so these tests deliberately never register a
 * provider: they prove `withSpan` runs `fn`, returns its value, and emits
 * nothing through the API's no-op tracer.
 *
 * Span-CAPTURE behavior (assertions that a real span is produced with the
 * expected name/attributes) is tested in `opensip-tools`, where the OTel
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

describe('withSpanAsync (async-aware span)', () => {
  it('awaits fn and returns its resolved value with no SDK registered', async () => {
    const sentinel = { value: 7 };
    const result = await withSpanAsync('test-scope', 'unit', async () => {
      await Promise.resolve();
      return sentinel;
    });
    expect(result).toBe(sentinel);
  });

  it('ends the span only after the awaited work settles (not when the callback returns)', async () => {
    const events: string[] = [];
    const span = {
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(() => events.push('end')),
      isRecording: () => false,
    };
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never,
    } as never);
    try {
      await withSpanAsync('test-scope', 'unit', async () => {
        await Promise.resolve();
        events.push('work-done');
      });
      // The span must end AFTER the awaited work, proving it spans the await.
      expect(events).toEqual(['work-done', 'end']);
    } finally {
      spy.mockRestore();
    }
  });

  it('records an async rejection, sets ERROR status, ends the span, and rejects', async () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const span = { setAttributes: vi.fn(), setStatus, recordException, end, isRecording: () => false };
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: ((_name: string, fn: (s: unknown) => unknown) => fn(span)) as never,
    } as never);
    const boom = new Error('async boom');
    try {
      await expect(
        withSpanAsync('test-scope', 'unit', async () => {
          await Promise.resolve();
          throw boom;
        }),
      ).rejects.toBe(boom);
      expect(recordException).toHaveBeenCalledWith(boom);
      expect(setStatus).toHaveBeenCalledWith({ code: 2 }); // SpanStatusCode.ERROR
      expect(end).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('currentTraceparent (subprocess context propagation)', () => {
  it('returns undefined when no SDK/propagator is registered (standalone runs)', () => {
    // No provider/propagator ⇒ the no-op tracer yields an invalid span context,
    // which the W3C propagator declines to serialize. Standalone runs spawning
    // a child thus pass no TRACEPARENT, and the child emits no spans.
    expect(currentTraceparent()).toBeUndefined();
  });
});
