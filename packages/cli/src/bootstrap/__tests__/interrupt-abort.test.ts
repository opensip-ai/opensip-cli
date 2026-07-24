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
});
