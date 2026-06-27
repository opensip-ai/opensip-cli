/**
 * Subprocess ProgressTransport (ADR-0028): forks the fixture worker over real
 * IPC and asserts the relay contract — event fan-out, pre-subscribe buffering,
 * result resolution, error propagation (message / throw / premature exit),
 * advanced-serialization payloads, and the in-process fallback selector.
 *
 * These spawn a real child process, so the suite is slower than the in-process
 * sibling; the fixture is a tiny `.mjs` run directly by node (no transform).
 */

import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createSubprocessProgressRun, runOffThreadOrInProcess } from '../subprocess-transport.js';

const FIXTURE = fileURLToPath(new URL('fixtures/progress-worker.mjs', import.meta.url));

function descriptorFor(mode: string): {
  command: string;
  argv: readonly string[];
} {
  return { command: FIXTURE, argv: [mode] };
}

describe('createSubprocessProgressRun', () => {
  it('relays progress events in order and resolves the result', async () => {
    const run = createSubprocessProgressRun<number, string>(descriptorFor('emit-and-result'));
    const events: number[] = [];
    run.onProgress((e) => events.push(e));
    const result = await run.result;
    expect(result).toBe('done');
    expect(events).toEqual([1, 2, 3]);
  });

  it('buffers events emitted before subscription and flushes them in order', async () => {
    // Subscribe only AFTER the result settles: every progress message has been
    // received and buffered (not dropped), then flushed on onProgress — parity
    // with the in-process transport's pre-subscribe buffering.
    const run = createSubprocessProgressRun<number, string>(descriptorFor('emit-and-result'));
    await run.result;
    const events: number[] = [];
    run.onProgress((e) => events.push(e));
    expect(events).toEqual([1, 2, 3]);
  });

  it('rejects the result with the reconstructed message on an error message', async () => {
    const run = createSubprocessProgressRun<number, string>(descriptorFor('error-message'));
    await expect(run.result).rejects.toThrow('worker blew up');
  });

  it('rejects when the worker throws and exits non-zero without a result', async () => {
    const run = createSubprocessProgressRun<number, string>(descriptorFor('throw'));
    await expect(run.result).rejects.toThrow(/worker exited/);
  });

  it('rejects when the worker exits cleanly without producing a result', async () => {
    const run = createSubprocessProgressRun<number, string>(descriptorFor('exit-clean'));
    await expect(run.result).rejects.toThrow(/before producing a result/);
  });

  it('rejects an oversized IPC payload from the worker', async () => {
    const prev = process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES;
    process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES = '1024';
    try {
      const run = createSubprocessProgressRun<number, string>(descriptorFor('huge-payload'));
      await expect(run.result).rejects.toThrow(/payload_too_large|too large/);
    } finally {
      if (prev === undefined) delete process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES;
      else process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES = prev;
    }
  });

  it('carries a Map across the boundary via advanced serialization', async () => {
    const run = createSubprocessProgressRun<number, { tag: string; map: Map<string, number> }>(
      descriptorFor('map-result'),
    );
    const result = await run.result;
    expect(result.tag).toBe('m');
    expect(result.map).toBeInstanceOf(Map);
    expect(result.map.get('a')).toBe(1);
  });
});

describe('runOffThreadOrInProcess', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_NO_WORKER;
  });

  it('runs the worker by default and resolves its result', async () => {
    const events: number[] = [];
    const run = runOffThreadOrInProcess<number, string>({
      descriptor: descriptorFor('emit-and-result'),
      inProcess: () => Promise.reject(new Error('must not run in-process')),
    });
    run.onProgress((e) => events.push(e));
    expect(await run.result).toBe('done');
    expect(events).toEqual([1, 2, 3]);
  });

  it('runs the in-process closure when preferWorker is false', async () => {
    const events: number[] = [];
    const run = runOffThreadOrInProcess<number, string>({
      descriptor: descriptorFor('throw'), // would reject if forked — proves it is not
      preferWorker: false,
      inProcess: (emit) => {
        emit(10);
        emit(20);
        return Promise.resolve('in-process');
      },
    });
    run.onProgress((e) => events.push(e));
    expect(await run.result).toBe('in-process');
    expect(events).toEqual([10, 20]);
  });

  it('runs the in-process closure when OPENSIP_CLI_NO_WORKER=1', async () => {
    process.env.OPENSIP_CLI_NO_WORKER = '1';
    const run = runOffThreadOrInProcess<number, string>({
      descriptor: descriptorFor('throw'),
      inProcess: () => Promise.resolve('env-gated in-process'),
    });
    expect(await run.result).toBe('env-gated in-process');
  });

  it('yields an identical result whether it ran off-thread or in-process', async () => {
    // The renderer must not care which path ran. The worker emits the same
    // [1,2,3]/'done' the in-process closure mirrors here.
    const worker = runOffThreadOrInProcess<number, string>({
      descriptor: descriptorFor('emit-and-result'),
      inProcess: () => Promise.reject(new Error('unused')),
    });
    process.env.OPENSIP_CLI_NO_WORKER = '1';
    const fallback = runOffThreadOrInProcess<number, string>({
      descriptor: descriptorFor('emit-and-result'),
      inProcess: (emit) => {
        emit(1);
        emit(2);
        emit(3);
        return Promise.resolve('done');
      },
    });
    const workerEvents: number[] = [];
    const fallbackEvents: number[] = [];
    worker.onProgress((e) => workerEvents.push(e));
    fallback.onProgress((e) => fallbackEvents.push(e));
    expect(await worker.result).toBe(await fallback.result);
    expect(workerEvents).toEqual(fallbackEvents);
  });
});
