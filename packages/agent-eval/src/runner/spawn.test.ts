import { describe, expect, it } from 'vitest';

import { spawnProcess, tailForDiagnostics } from './spawn.js';

describe('spawnProcess', () => {
  it('captures output and nonzero exits without throwing', async () => {
    const result = await spawnProcess(process.execPath, [
      '-e',
      "const fs=require('node:fs');fs.writeSync(1,'out');fs.writeSync(2,'err');globalThis['process'].exitCode=7",
    ]);
    expect(result).toMatchObject({
      exitCode: 7,
      outputLimitExceeded: false,
      stderr: 'err',
      stdout: 'out',
      timedOut: false,
    });
  });

  it('terminates a child that exceeds the time bound', async () => {
    const started = Date.now();
    const result = await spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('terminates and truncates a child that exceeds the output bound', async () => {
    const result = await spawnProcess(
      process.execPath,
      ['-e', "require('node:fs').writeSync(1,'x'.repeat(100000))"],
      { maxOutputBytes: 128 },
    );
    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128);
  });
});

describe('tailForDiagnostics', () => {
  it('returns short text unchanged', () => {
    expect(tailForDiagnostics('short', 16)).toBe('short');
  });

  it('returns a marked UTF-8-bounded suffix', () => {
    const value = tailForDiagnostics(`prefix-${'é'.repeat(100)}`, 64);
    expect(value).toContain('[output truncated]');
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64);
  });
});
