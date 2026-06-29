import { EXIT_CODES } from '@opensip-cli/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createCapturingContext } from '../capturing-context.js';

import type { SignalDeliveryResult, ToolCliContext } from '@opensip-cli/core';

/**
 * Build a capturing context whose `base.deliverSignals` resolves a caller-chosen
 * {@link SignalDeliveryResult}. The mirror under test reads `result.reportSuccess`,
 * so this is the real host-deliver seam (NOT the mirror) being stubbed — the
 * capturing-context exit derivation itself stays fully exercised.
 */
function captureWith(deliveryResult?: Partial<SignalDeliveryResult>) {
  const result = deliveryResult ?? { cloudAccepted: 0 };
  const deliverSignals = vi.fn(() => Promise.resolve(result));
  const base = { deliverSignals, setExitCode: vi.fn() } as unknown as ToolCliContext;
  return createCapturingContext(base);
}

describe('createCapturingContext', () => {
  it('captures setExitCode and deliverSignals side effects (last-write-wins)', async () => {
    const deliverSignals = vi.fn(() => Promise.resolve({ cloudAccepted: 1 }));
    const base = {
      deliverSignals,
      setExitCode: vi.fn(),
    } as unknown as ToolCliContext;

    const capture = createCapturingContext(base);
    capture.context.setExitCode(2);
    await capture.context.deliverSignals({}, { runFailed: true });

    // runFailed override DOMINATES and OVERWRITES the earlier setExitCode(2).
    expect(capture.getExitCode()).toBe(EXIT_CODES.RUNTIME_ERROR);
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
    expect(capture.getExitCode()).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('does not capture an exit for a passing-verdict delivery', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals({ verdict: { passed: true } }, { cwd: '/x' });
    expect(capture.getExitCode()).toBeUndefined();
  });

  it('honours an explicit runFailed=false (clean gate compare) over a failing verdict', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals(
      { verdict: { passed: false } },
      { cwd: '/x', runFailed: false },
    );
    expect(capture.getExitCode()).toBeUndefined();
  });

  // Regression #4 (LOW) — advisory-exit parity (yagni faulting-detector → lower).
  // A faulting detector forces `verdict.passed=false`, so the mirror raises the slot
  // to RUNTIME_ERROR; yagni's `applyAdvisoryExitCode` then re-affirms SUCCESS. With
  // the old append-only `number[]` + `Math.max`, the array ended `[1, 0]` → max = 1,
  // so the suite exited 1 where the standalone yagni run exits 0. The last-write-wins
  // slot must LOWER back to SUCCESS.
  it('lets a later setExitCode(SUCCESS) lower a delivery-raised exit (advisory parity)', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals({ verdict: { passed: false } }, { cwd: '/x' });
    expect(capture.getExitCode()).toBe(EXIT_CODES.RUNTIME_ERROR);
    capture.context.setExitCode(EXIT_CODES.SUCCESS);
    expect(capture.getExitCode()).toBe(EXIT_CODES.SUCCESS);
  });

  // Regression #1 (MEDIUM) — ADR-0008 gate integrity. A PASSING step whose
  // `--report-to` upload fails: the host's deliverEnvelope writes REPORT_FAILED(4)
  // through its OWN setExitCode, bypassing this wrapper. The mirror must inspect the
  // returned `SignalDeliveryResult.reportSuccess` and capture exit 4 — otherwise the
  // step exits 0 in a suite vs 4 standalone (a silent CI gate bypass).
  it('captures REPORT_FAILED when a passing run reports `reportSuccess === false`', async () => {
    const capture = captureWith({ cloudAccepted: 0, reportSuccess: false });
    await capture.context.deliverSignals(
      { verdict: { passed: true } },
      { cwd: '/x', reportTo: 'https://example.test/report' },
    );
    expect(capture.getExitCode()).toBe(EXIT_CODES.REPORT_FAILED);
  });

  // Precedence: runFailed DOMINATES a report failure (ADR-0008 — a real failure is
  // never masked by, nor downgraded to, exit 4).
  it('lets runFailed dominate a concurrent report failure (1, never 4)', async () => {
    const capture = captureWith({ cloudAccepted: 0, reportSuccess: false });
    await capture.context.deliverSignals(
      { verdict: { passed: false } },
      { cwd: '/x', reportTo: 'https://example.test/report' },
    );
    expect(capture.getExitCode()).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  // No-report pass: `reportSuccess` is undefined (no `--report-to`), so the strict
  // `=== false` never fires and a clean run leaves the slot untouched (→ SUCCESS).
  it('captures no exit for a passing run with no report target', async () => {
    const capture = captureWith();
    await capture.context.deliverSignals({ verdict: { passed: true } }, { cwd: '/x' });
    expect(capture.getExitCode()).toBeUndefined();
  });
});
