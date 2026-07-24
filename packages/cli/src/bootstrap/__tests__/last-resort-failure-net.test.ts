import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installLastResortFailureNet,
  resetLastResortFailureNetForTests,
} from '../last-resort-failure-net.js';

describe('installLastResortFailureNet', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    resetLastResortFailureNetForTests();
    // Remove any prior listeners from a previous install (idempotent install
    // would no-op; reset allows a clean process.on for each test).
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    resetLastResortFailureNetForTests();
    process.exitCode = savedExitCode;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes a coded fatal line and exits on uncaughtException', () => {
    installLastResortFailureNet();
    process.emit('uncaughtException', new Error('boom-uncaught'));
    expect(stderrSpy).toHaveBeenCalled();
    const line = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toMatch(/fatal uncaughtException/);
    expect(line).toMatch(/\[SYSTEM_ERROR\] The operation failed\./);
    expect(line).not.toMatch(/boom-uncaught/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('writes a coded fatal line and exits on unhandledRejection (same as uncaught)', () => {
    installLastResortFailureNet();
    process.emit('unhandledRejection', new Error('boom-reject'), Promise.resolve());
    expect(stderrSpy).toHaveBeenCalled();
    const line = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toMatch(/fatal unhandledRejection/);
    expect(line).toMatch(/\[SYSTEM_ERROR\] The operation failed\./);
    expect(line).not.toMatch(/boom-reject/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('is idempotent — second install does not double-register', () => {
    installLastResortFailureNet();
    installLastResortFailureNet();
    process.emit('uncaughtException', new Error('once'));
    // One stderr write + one exit (not doubled)
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
