/**
 * In-process ProgressTransport (ADR-0016): event fan-out, pre-subscribe
 * buffering, and result resolution/rejection.
 */

import { describe, it, expect } from 'vitest';

import { createInProcessTransport } from '../in-process-transport.js';

describe('createInProcessTransport', () => {
  it('resolves the job result and delivers its events', async () => {
    const transport = createInProcessTransport();
    const events: number[] = [];
    const run = transport.run<number, string>((emit) => {
      emit(1);
      emit(2);
      return Promise.resolve('done');
    });
    run.onProgress((e) => events.push(e));
    const result = await run.result;
    expect(result).toBe('done');
    expect(events).toEqual([1, 2]);
  });

  it('buffers events emitted before subscription and flushes them in order', async () => {
    const transport = createInProcessTransport();
    const events: string[] = [];
    // The job emits synchronously inside run(), BEFORE onProgress is called —
    // these must be buffered and replayed on subscription, not dropped.
    const run = transport.run<string, void>((emit) => {
      emit('a');
      emit('b');
      return Promise.resolve();
    });
    run.onProgress((e) => events.push(e));
    await run.result;
    expect(events).toEqual(['a', 'b']);
  });

  it('delivers events emitted after subscription live, in order', async () => {
    const transport = createInProcessTransport();
    const events: string[] = [];
    let emitFn: ((e: string) => void) | undefined;
    const run = transport.run<string, void>((emit) => {
      emitFn = emit;
      return new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    });
    run.onProgress((e) => events.push(e));
    emitFn?.('live1');
    emitFn?.('live2');
    await run.result;
    expect(events).toEqual(['live1', 'live2']);
  });

  it('combines buffered + live events in one ordered stream', async () => {
    const transport = createInProcessTransport();
    const events: string[] = [];
    let emitFn: ((e: string) => void) | undefined;
    const run = transport.run<string, void>((emit) => {
      emit('buffered');
      emitFn = emit;
      return new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    });
    run.onProgress((e) => events.push(e));
    emitFn?.('live');
    await run.result;
    expect(events).toEqual(['buffered', 'live']);
  });

  it('rejects result when the job rejects', async () => {
    const transport = createInProcessTransport();
    const run = transport.run<never, void>(() => Promise.reject(new Error('boom')));
    await expect(run.result).rejects.toThrow('boom');
  });
});
