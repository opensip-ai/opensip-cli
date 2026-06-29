import { EXIT_CODES } from '@opensip-cli/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createCapturingContext } from '../capturing-context.js';

import type { ToolCliContext } from '@opensip-cli/core';

function captureWith() {
  const deliverSignals = vi.fn(() => Promise.resolve({ accepted: 0, authRejected: false }));
  const base = { deliverSignals, setExitCode: vi.fn() } as unknown as ToolCliContext;
  return createCapturingContext(base);
}

describe('createCapturingContext', () => {
  it('captures setExitCode and deliverSignals side effects', async () => {
    const deliverSignals = vi.fn(() => Promise.resolve({ accepted: 1, authRejected: false }));
    const base = {
      deliverSignals,
      setExitCode: vi.fn(),
    } as unknown as ToolCliContext;

    const capture = createCapturingContext(base);
    capture.context.setExitCode(2);
    await capture.context.deliverSignals({}, { runFailed: true });

    expect(capture.exitCodes).toEqual([2, 1]);
    expect(capture.signalDeliveries).toHaveLength(1);
    expect(deliverSignals).toHaveBeenCalled();
  });

  // Regression (04↔05 suite step): the host's deliverEnvelope derives the findings
  // exit as `opts.runFailed ?? !verdict.passed` and applies it through its OWN exit
  // writer (bypassing this wrapper's setExitCode override). A normal findings run
  // delivers WITHOUT a runFailed override, so the wrapper must re-derive from the
  // envelope verdict — otherwise an external/bundled step's findings silently
  // aggregate to a passing suite exit.
  it('captures a verdict-derived findings exit when no runFailed override is given', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals({ verdict: { passed: false } }, { cwd: '/x' });
    expect(capture.exitCodes).toEqual([EXIT_CODES.RUNTIME_ERROR]);
  });

  it('does not capture an exit for a passing-verdict delivery', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals({ verdict: { passed: true } }, { cwd: '/x' });
    expect(capture.exitCodes).toEqual([]);
  });

  it('honours an explicit runFailed=false (clean gate compare) over a failing verdict', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals(
      { verdict: { passed: false } },
      { cwd: '/x', runFailed: false },
    );
    expect(capture.exitCodes).toEqual([]);
  });
});
