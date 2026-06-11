/**
 * @fileoverview Tests for execAbortable.
 *
 * Covers the array and shell modes, abort signal handling (pre-spawn
 * and during execution), timeout, and error paths (empty array,
 * spawn failure).
 */

import { SystemError } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { execAbortable } from '../abortable-exec.js';

describe('execAbortable — array mode', () => {
  it('runs a command and returns stdout / exit code', async () => {
    const result = await execAbortable(['echo', 'hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await execAbortable(['sh', '-c', 'echo to-stderr 1>&2']);
    expect(result.stderr.trim()).toBe('to-stderr');
    expect(result.exitCode).toBe(0);
  });

  it('preserves multi-byte UTF-8 output split across stream chunks', async () => {
    // A large payload is delivered by the OS pipe in multiple ~64 KiB
    // 'data' chunks. A 3-byte char (中, U+4E2D) is used deliberately:
    // 65536 is not a multiple of 3, so the chunk boundary lands
    // mid-character. Without setEncoding, per-chunk decoding emits U+FFFD
    // replacement chars there. (A 4-byte char would falsely pass — 65536
    // is divisible by 4, so its boundaries align.)
    const count = 300_000;
    const result = await execAbortable([
      process.execPath,
      '-e',
      `process.stdout.write('中'.repeat(${count}))`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('�');
    expect(result.stdout).toBe('中'.repeat(count));
  });

  it('returns a non-zero exit code without throwing', async () => {
    const result = await execAbortable(['sh', '-c', 'exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.aborted).toBe(false);
  });

  it('rejects with SystemError when the command array is empty', async () => {
    await expect(execAbortable([])).rejects.toThrow(SystemError);
  });

  it('rejects with ExecError when the binary cannot be spawned', async () => {
    await expect(execAbortable(['definitely-not-a-real-binary-zzz'])).rejects.toMatchObject({
      name: 'ExecError',
    });
  });
});

describe('execAbortable — shell (string) mode', () => {
  it('runs a string command via the shell and returns stdout', async () => {
    const result = await execAbortable('echo shell-mode');
    expect(result.stdout.trim()).toBe('shell-mode');
    expect(result.exitCode).toBe(0);
  });

  it('returns shell exit code 127 for an unknown command', async () => {
    // sh -c emits 127 when the command name isn't found; the wrapper
    // doesn't classify this as an error — it surfaces the exit code.
    const result = await execAbortable('definitely-not-a-real-binary-zzz');
    expect(result.exitCode).toBe(127);
  });
});

describe('execAbortable — abort signal', () => {
  it('returns aborted=true immediately when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await execAbortable(['echo', 'never-runs'], { signal: ctrl.signal });
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('aborts a running process when the signal fires mid-execution', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const result = await execAbortable(['sh', '-c', 'sleep 5'], { signal: ctrl.signal });
    expect(result.aborted).toBe(true);
  });
});

describe('execAbortable — timeout', () => {
  it('aborts a running process when timeout elapses', async () => {
    const result = await execAbortable(['sh', '-c', 'sleep 5'], { timeout: 50 });
    expect(result.aborted).toBe(true);
  });

  it('does not abort fast commands', async () => {
    const result = await execAbortable(['echo', 'quick'], { timeout: 5000 });
    expect(result.aborted).toBe(false);
    expect(result.stdout.trim()).toBe('quick');
  });
});

describe('execAbortable — buffering', () => {
  it('caps stdout buffer at maxBuffer', async () => {
    // Generate 200 KB of stdout and cap buffer at 1 KB. The spawned
    // process succeeds; buffer cap just truncates what we capture.
    const result = await execAbortable(['sh', '-c', 'yes x | head -c 200000'], { maxBuffer: 1024 });
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(result.exitCode).toBeDefined();
  });
});
