import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runJsonSpecWorker } from '../json-spec-worker.js';

const ORIGINAL_SEND_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'send');

function restoreProcessSend(): void {
  if (ORIGINAL_SEND_DESCRIPTOR === undefined) {
    delete (process as NodeJS.Process & { send?: NodeJS.Process['send'] }).send;
    return;
  }
  Object.defineProperty(process, 'send', ORIGINAL_SEND_DESCRIPTOR);
}

function captureWorkerMessages(): unknown[] {
  const messages: unknown[] = [];
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: (msg: unknown) => {
      messages.push(msg);
      return true;
    },
  });
  return messages;
}

function writeSpec(dir: string, payload: unknown): string {
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(payload), 'utf8');
  return specPath;
}

describe('runJsonSpecWorker', () => {
  let dir: string | undefined;

  afterEach(() => {
    restoreProcessSend();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the JSON spec, emits progress, and sends the result', async () => {
    dir = mkdtempSync(join(tmpdir(), 'json-spec-worker-'));
    const specPath = writeSpec(dir, { value: 41 });
    const messages = captureWorkerMessages();

    await runJsonSpecWorker<{ value: number }, { kind: string }, number>({
      specPath,
      startEvent: { kind: 'start' },
      run: (args, emit) => {
        emit({ kind: 'loaded' });
        return Promise.resolve(args.value + 1);
      },
    });

    expect(messages).toEqual([
      { kind: 'progress', event: { kind: 'start' } },
      { kind: 'progress', event: { kind: 'loaded' } },
      { kind: 'result', value: 42 },
    ]);
  });

  it('sends structured error messages with failure class and stack when run throws', async () => {
    dir = mkdtempSync(join(tmpdir(), 'json-spec-worker-'));
    const specPath = writeSpec(dir, { value: 1 });
    const messages = captureWorkerMessages();
    const error = new Error('worker timed out') as Error & { failureClass: string };
    error.failureClass = 'timeout';

    await runJsonSpecWorker<{ value: number }, never, never>({
      specPath,
      run: () => Promise.reject(error),
    });

    expect(messages).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: 'worker timed out',
        stack: expect.stringContaining('worker timed out'),
        failureClass: 'timeout',
      }),
    ]);
  });

  it('omits the failure class when the Error has none', async () => {
    dir = mkdtempSync(join(tmpdir(), 'json-spec-worker-'));
    const specPath = writeSpec(dir, { value: 1 });
    const messages = captureWorkerMessages();

    await runJsonSpecWorker<{ value: number }, never, never>({
      specPath,
      run: () => Promise.reject(new Error('plain failure')),
    });

    expect(messages).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: 'plain failure',
        stack: expect.stringContaining('plain failure'),
      }),
    ]);
    expect(messages[0]).not.toHaveProperty('failureClass');
  });
});
