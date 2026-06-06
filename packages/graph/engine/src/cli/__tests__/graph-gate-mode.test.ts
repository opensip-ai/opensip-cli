/**
 * ADR-0020: `graph --gate-save` (the `graph:ci` dogfood gate) must HARD-FAIL the
 * step on an error-level finding (core's `isErrorSignal` rung: `critical`/`high`),
 * not exit 0 and lean entirely on the downstream Code Scanning net-new ratchet.
 * These tests pin that exit-code contract for `runGateMode`'s gate-save branch —
 * the graph mirror of `fitness/.../fit-gate-mode.test.ts`.
 *
 * The `signals` array reaching `runGateMode` is the already suppression-filtered
 * (`@graph-ignore`, ADR-0014) `kept` set (see `cli/graph.ts`), so an error-rung
 * signal here is by definition UNSUPPRESSED — exactly what should trip the gate.
 * We drive the verdict directly via the signal set rather than mocking the engine.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { createSignal, type Signal, type ToolCliContext } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGateMode } from '../graph-modes.js';

import type { GraphCommandOptions } from '../graph-options.js';

let datastore: DataStore;

function signal(over: Partial<Parameters<typeof createSignal>[0]> = {}): Signal {
  return createSignal({
    source: 'graph',
    severity: 'medium',
    ruleId: 'graph:wide-function',
    message: 'msg',
    code: { file: 'src/a.ts', line: 1 },
    ...over,
  });
}

function mockCli(): { cli: ToolCliContext; setExitCode: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> } {
  const setExitCode = vi.fn();
  const render = vi.fn(() => Promise.resolve());
  const cli = {
    setExitCode,
    render,
    logger: console,
    scope: { datastore: () => datastore },
  } as unknown as ToolCliContext;
  return { cli, setExitCode, render };
}

function gateSaveOpts(): GraphCommandOptions {
  return { cwd: '/x', gateSave: true };
}

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  vi.clearAllMocks();
});

afterEach(() => {
  datastore.close();
  vi.restoreAllMocks();
});

describe('runGateMode --gate-save (ADR-0020 graph hard-fail)', () => {
  it('passes the step (exit SUCCESS) when the (unsuppressed) signal set is clean', async () => {
    const { cli, setExitCode } = mockCli();

    await runGateMode(gateSaveOpts(), [], cli, 'exact');

    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.SUCCESS);
    expect(setExitCode).not.toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
  });

  it('still passes when only warning-rung (medium/low) findings are present', async () => {
    const { cli, setExitCode } = mockCli();

    await runGateMode(
      gateSaveOpts(),
      [signal({ severity: 'medium' }), signal({ severity: 'low' })],
      cli,
      'exact',
    );

    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.SUCCESS);
    expect(setExitCode).not.toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
  });

  it('hard-fails the step (exit RUNTIME_ERROR) when an error-rung (high/critical) finding is present', async () => {
    const { cli, setExitCode, render } = mockCli();

    await runGateMode(
      gateSaveOpts(),
      [signal({ severity: 'medium' }), signal({ severity: 'high' })],
      cli,
      'exact',
    );

    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.RUNTIME_ERROR);
    // The baseline is still saved (rendered) even though the gate failed — the
    // SARIF export runs in a separate `if: always()` CI step.
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gate-done',
        lines: expect.arrayContaining([expect.stringContaining('Graph gate FAILED')]),
      }),
    );
  });
});
