import { EXIT_CODES } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { deriveStepOutcome } from '../suite-step-runner.js';

describe('deriveStepOutcome', () => {
  it("derives 'passed' from a passing envelope with no host error", () => {
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: { passed: true, faulted: false },
        exitCode: EXIT_CODES.SUCCESS,
      }),
    ).toBe('passed');
  });

  it("derives 'failed' from a non-passing, non-faulted envelope (findings crossed the gate)", () => {
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: { passed: false, faulted: false },
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      }),
    ).toBe('failed');
  });

  it("derives 'faulted' from a UNIT-level fault — envelope faulted, NO host error (the regression)", () => {
    // The old aggregate keyed `faulted` on `step.error`, which is set only for a
    // run-LEVEL throw. A check that threw INSIDE the tool emits an envelope whose
    // verdict.faulted is true but leaves `error` absent — and was mislabeled
    // `failed`. The envelope's fault bit must win.
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: { passed: false, faulted: true },
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      }),
    ).toBe('faulted');
  });

  it("derives 'faulted' when the host caught a runtime issue even over a passing envelope", () => {
    // A reportFailure on an otherwise-passing run lands in `errorMessage`; a
    // host-caught runtime issue is a fault regardless of the envelope verdict.
    expect(
      deriveStepOutcome({
        errorMessage: 'report upload failed',
        envelopeVerdict: { passed: true, faulted: false },
        exitCode: EXIT_CODES.SUCCESS,
      }),
    ).toBe('faulted');
  });

  it("derives 'faulted' from a thrown step that never emitted an envelope", () => {
    expect(
      deriveStepOutcome({
        errorMessage: 'boom',
        envelopeVerdict: undefined,
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      }),
    ).toBe('faulted');
  });

  it("falls back to the exit code with no envelope and no error: SUCCESS → 'passed'", () => {
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: undefined,
        exitCode: EXIT_CODES.SUCCESS,
      }),
    ).toBe('passed');
  });

  it("falls back to the exit code with no envelope and no error: non-zero → 'failed'", () => {
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: undefined,
        exitCode: 2,
      }),
    ).toBe('failed');
  });

  it('degrades a legacy envelope verdict without `faulted` to binary passed/failed', () => {
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: { passed: true },
        exitCode: EXIT_CODES.SUCCESS,
      }),
    ).toBe('passed');
    expect(
      deriveStepOutcome({
        errorMessage: undefined,
        envelopeVerdict: { passed: false },
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      }),
    ).toBe('failed');
  });
});
