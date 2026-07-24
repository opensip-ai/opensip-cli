import { afterEach, describe, expect, it, vi } from 'vitest';

import { installInterruptAbortCoordinator } from '../interrupt-abort.js';

describe('installInterruptAbortCoordinator', () => {
  afterEach(() => {
    // Ensure listeners cleaned between tests
  });

  it('aborts the root signal on first SIGINT', () => {
    const onFirst = vi.fn();
    const coord = installInterruptAbortCoordinator({ onFirstInterrupt: onFirst });
    expect(coord.signal.aborted).toBe(false);
    process.emit('SIGINT');
    expect(coord.signal.aborted).toBe(true);
    expect(onFirst).toHaveBeenCalledWith('SIGINT');
    coord.dispose();
  });

  it('dispose removes listeners', () => {
    const before = process.listenerCount('SIGINT');
    const coord = installInterruptAbortCoordinator();
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(before);
    coord.dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('second SIGINT within the grace window escalates via process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const coord = installInterruptAbortCoordinator({ secondInterruptWindowMs: 60_000 });
    process.emit('SIGINT');
    expect(coord.signal.aborted).toBe(true);
    process.emit('SIGINT');
    expect(exitSpy).toHaveBeenCalledWith(130);
    exitSpy.mockRestore();
    coord.dispose();
  });

  it('grace expiry after a single SIGTERM force-exits with 143', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const coord = installInterruptAbortCoordinator({ secondInterruptWindowMs: 50 });
    process.emit('SIGTERM');
    expect(coord.signal.aborted).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(exitSpy).toHaveBeenCalledWith(143);
    exitSpy.mockRestore();
    coord.dispose();
    vi.useRealTimers();
  });

  it('cleanup callbacks that throw do not rethrow from the signal handler', () => {
    const coord = installInterruptAbortCoordinator({
      onFirstInterrupt: () => {
        throw new Error('cleanup boom');
      },
    });
    expect(() => process.emit('SIGINT')).not.toThrow();
    expect(coord.signal.aborted).toBe(true);
    coord.dispose();
  });
});
