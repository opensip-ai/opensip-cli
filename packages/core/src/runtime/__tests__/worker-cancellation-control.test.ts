import { afterEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  send: vi.fn<() => Promise<void>>(),
}));

vi.mock('../worker-ipc-send.js', () => ({
  sendWorkerIpcMessageAndDrain: ipc.send,
}));

import {
  startWorkerCancellationControl,
  WORKER_CONTROL_WIRE_VERSION,
} from '../worker-cancellation-control.js';

function installedMessageListener(): (message: unknown) => void {
  const listener = process.listeners('message').at(-1);
  if (listener === undefined) throw new Error('worker cancellation listener was not installed');
  return listener as (message: unknown) => void;
}

async function flushCancellation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startWorkerCancellationControl', () => {
  afterEach(() => {
    ipc.send.mockReset();
    vi.restoreAllMocks();
  });

  it('ignores malformed, accessor-backed, and hostile IPC messages', () => {
    const stop = startWorkerCancellationControl();
    try {
      const onMessage = installedMessageListener();
      const accessor = {};
      Object.defineProperty(accessor, 'kind', { get: () => 'cancel-request' });
      const hostile = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('descriptor trap');
          },
        },
      );

      for (const message of [null, 'cancel-request', {}, accessor, hostile]) onMessage(message);
      expect(ipc.send).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('acknowledges one valid request and delivers one local SIGTERM', async () => {
    ipc.send.mockResolvedValue();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const stop = startWorkerCancellationControl();
    try {
      const onMessage = installedMessageListener();
      const request = {
        kind: 'cancel-request',
        controlVersion: WORKER_CONTROL_WIRE_VERSION,
      };
      onMessage(request);
      onMessage(request);
      await flushCancellation();

      expect(ipc.send).toHaveBeenCalledOnce();
      expect(ipc.send).toHaveBeenCalledWith({
        kind: 'cancel-ack',
        controlVersion: WORKER_CONTROL_WIRE_VERSION,
      });
      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      stop();
    }
  });

  it('still attempts local cancellation when acknowledgement and kill fail', async () => {
    ipc.send.mockRejectedValue(new Error('closed IPC'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('signal unavailable');
    });
    const stop = startWorkerCancellationControl();
    try {
      installedMessageListener()({
        kind: 'cancel-request',
        controlVersion: WORKER_CONTROL_WIRE_VERSION,
      });
      await flushCancellation();

      expect(ipc.send).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      stop();
    }
  });
});
