import { afterEach, describe, expect, it, vi } from 'vitest';

import { killTree } from '../kill-tree.js';
import {
  assertCapturedOutputFits,
  CapturedOutputTooLargeError,
} from '../result-accumulator-cap.js';
import { readChildRssBytes, startRssWatchdog } from '../rss-watchdog.js';
import { CapturedStderr } from '../stderr-capture.js';
import {
  IpcPayloadTooLargeError,
  sendWorkerIpcMessage,
  sendWorkerIpcMessageAndDrain,
} from '../worker-ipc-send.js';

import type { ChildProcess } from 'node:child_process';

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SEND_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'send');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value,
  });
}

function restoreProcessSend(): void {
  if (ORIGINAL_SEND_DESCRIPTOR === undefined) {
    delete (process as NodeJS.Process & { send?: NodeJS.Process['send'] }).send;
    return;
  }
  Object.defineProperty(process, 'send', ORIGINAL_SEND_DESCRIPTOR);
}

describe('runtime hardening helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(ORIGINAL_PLATFORM);
    restoreProcessSend();
  });

  it('caps captured stderr to the trailing byte window', () => {
    const captured = new CapturedStderr(5);

    captured.append('');
    expect(captured.tail()).toBe('');

    captured.append('abcdef');
    expect(captured.tail()).toBe('bcdef');

    captured.append(Buffer.from('gh'));
    expect(captured.tail()).toBe('defgh');
  });

  it('rejects captured output that exceeds the serialized output cap', () => {
    expect(() => assertCapturedOutputFits('stdout', { ok: true }, 1024)).not.toThrow();
    expect(() => assertCapturedOutputFits('stderr', 'x'.repeat(256), 8)).toThrow(
      CapturedOutputTooLargeError,
    );
  });

  it('guards worker IPC sends with the configured payload cap', async () => {
    const sent: unknown[] = [];
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: (msg: unknown, cb?: (error: Error | null) => void) => {
        sent.push(msg);
        cb?.(null);
        return true;
      },
    });

    sendWorkerIpcMessage({ kind: 'ok' }, 1024);
    expect(sent).toEqual([{ kind: 'ok' }]);
    expect(() => sendWorkerIpcMessage({ value: 'x'.repeat(256) }, 8)).toThrow(
      IpcPayloadTooLargeError,
    );

    await sendWorkerIpcMessageAndDrain({ kind: 'result' }, 1024);
    expect(sent).toEqual([{ kind: 'ok' }, { kind: 'result' }]);
    await expect(
      sendWorkerIpcMessageAndDrain({ value: 'x'.repeat(256) }, 8),
    ).rejects.toBeInstanceOf(IpcPayloadTooLargeError);
  });

  it('drain treats send-returns-false as backpressure while connected, fatal only when disconnected', async () => {
    const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
    const setConnected = (value: boolean): void => {
      Object.defineProperty(process, 'connected', { configurable: true, value });
    };
    try {
      // Backpressure: send returns false but the channel is connected and the
      // write callback later succeeds — the terminal message must NOT be
      // treated as fatal (a busy host-RPC pipe returns false routinely).
      Object.defineProperty(process, 'send', {
        configurable: true,
        value: (_msg: unknown, cb?: (error: Error | null) => void) => {
          setImmediate(() => cb?.(null));
          return false;
        },
      });
      setConnected(true);
      await expect(sendWorkerIpcMessageAndDrain({ kind: 'result' }, 1024)).resolves.toBeUndefined();

      // Disconnected: false means the channel is genuinely gone — reject.
      setConnected(false);
      await expect(sendWorkerIpcMessageAndDrain({ kind: 'result' }, 1024)).rejects.toThrow(
        /channel closed/,
      );
    } finally {
      if (originalConnected === undefined) {
        delete (process as { connected?: boolean }).connected;
      } else {
        Object.defineProperty(process, 'connected', originalConnected);
      }
      restoreProcessSend();
    }
  });

  it('falls back to child.kill when pid is unavailable or taskkill is unavailable', () => {
    const noPidKill = vi.fn();
    killTree({ kill: noPidKill } as unknown as ChildProcess, 'SIGTERM');
    expect(noPidKill).toHaveBeenCalledWith('SIGTERM');

    const throwingKill = vi.fn(() => {
      throw new Error('already exited');
    });
    expect(() =>
      killTree({ kill: throwingKill } as unknown as ChildProcess, 'SIGTERM'),
    ).not.toThrow();

    setPlatform('win32');
    const windowsKill = vi.fn();
    killTree({ pid: 123_456_789, kill: windowsKill } as unknown as ChildProcess, 9);
    expect(windowsKill).toHaveBeenCalledWith(9);
  });

  it('samples child RSS defensively across invalid and platform-specific paths', () => {
    expect(readChildRssBytes(0)).toBeUndefined();
    expect(readChildRssBytes(Number.NaN)).toBeUndefined();
    expect(readChildRssBytes(process.pid)).toBeGreaterThan(0);

    setPlatform('win32');
    expect(readChildRssBytes(123_456_789)).toBeUndefined();
  });

  it('does not fire the RSS watchdog when the child pid is unavailable', async () => {
    const onExceeded = vi.fn();
    const watchdog = startRssWatchdog({
      child: {} as ChildProcess,
      maxRssMb: 1,
      intervalMs: 5,
      onExceeded,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    watchdog.stop();

    expect(onExceeded).not.toHaveBeenCalled();
  });
});
