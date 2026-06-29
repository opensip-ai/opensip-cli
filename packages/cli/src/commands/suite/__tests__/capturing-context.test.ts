import { describe, expect, it, vi } from 'vitest';

import { createCapturingContext } from '../capturing-context.js';

import type { ToolCliContext } from '@opensip-cli/core';

describe('createCapturingContext', () => {
  it('captures setExitCode and deliverSignals side effects', async () => {
    const deliverSignals = vi.fn(() => Promise.resolve({ accepted: 1, authRejected: false }));
    const base = {
      deliverSignals,
      setExitCode: vi.fn(),
    } as unknown as ToolCliContext;

    const capture = createCapturingContext(base);
    capture.context.setExitCode(2);
    await capture.context.deliverSignals({} as never, { runFailed: true });

    expect(capture.exitCodes).toEqual([2, 1]);
    expect(capture.signalDeliveries).toHaveLength(1);
    expect(deliverSignals).toHaveBeenCalled();
  });
});