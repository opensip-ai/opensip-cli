/**
 * @fileoverview Behavioural tests for the `sim` live-view state machine
 * (ADR-0016). Drives `<SimRunner>` directly under ink-testing-library — no real
 * TTY `render()` host — and asserts the rendered frames reflect each phase:
 *
 *   - loading → running → done: the banner/run-header, the live spinner, and
 *     the final pass/fail RunSummary, with the run's SignalEnvelope handed back
 *     via `onEnvelope`.
 *   - failing scenario: `setExitCode(RUNTIME_ERROR)` fires when a scenario
 *     fails (the run still completes and shows a summary).
 *   - unknown recipe: the error phase renders <ErrorMessage> and reports the
 *     configuration exit code.
 *   - `--quiet`: the banner/header block is suppressed, leaving only the
 *     summary.
 *   - `mini` banner with an available update: the inline UpdateHint renders.
 *
 * The assertions inspect event-driven frame content (labels, counters,
 * pass/fail glyphs), never the animated spinner frame, so they're
 * deterministic. `waitForFrame` polls the latest frame to absorb React's async
 * re-renders.
 */

import { enterScope, RunScope } from '@opensip-cli/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { noopTarget } from '../../__tests__/test-utils/targets.js';
import { ASSERTIONS } from '../../framework/assertions.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../../framework/registry.js';
import { defineLoadScenario } from '../../kinds/load/define.js';
import { simulationTool } from '../../tool.js';
import { SimRunner } from '../sim-runner.js';

import type { SignalEnvelope, ToolOptions } from '@opensip-cli/contracts';
import type { RunScopeOptions } from '@opensip-cli/core';

// The live runner forks `sim-run-worker` off the main process (ADR-0028), but in
// the test runner `process.argv[1]` is vitest, not the CLI — so force the
// in-process fallback, which exercises the SimRunner state machine directly
// against the scope each test sets up. (The fork path is covered by a dedicated
// subprocess harness, not the component unit tests.)
beforeAll(() => {
  process.env.OPENSIP_CLI_NO_WORKER = '1';
});
afterAll(() => {
  delete process.env.OPENSIP_CLI_NO_WORKER;
});

afterEach(() => {
  // Each test enters its own scope; clear the scenario registry between runs.
  try {
    clearScenarioRegistry();
  } catch {
    // No active scope (a test that never entered one) — nothing to clear.
  }
});

/** Enter a fresh scope (with the simulation subscope attached) plus any
 *  presentation context the header branch under test needs. */
function enterSimScope(opts: RunScopeOptions = {}): void {
  const scope = new RunScope(opts);
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  enterScope(scope);
}

function registerProbe(id = 'probe'): void {
  currentScenarioRegistry().register(
    defineLoadScenario({
      id,
      name: id,
      description: id,
      tags: [],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }),
  );
}

const baseArgs = (
  overrides: Partial<ToolOptions & { quiet?: boolean }> = {},
): ToolOptions & { quiet?: boolean } => ({
  json: false,
  cwd: process.cwd(),
  debug: false,
  ...overrides,
});

/** Poll the latest frame until it contains `substr` (or time out). */
async function waitForFrame(lastFrame: () => string | undefined, substr: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((lastFrame() ?? '').includes(substr)) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe('<SimRunner> — live-view state machine', () => {
  it('renders the run header, then the final pass summary, and returns the envelope', async () => {
    enterSimScope();
    registerProbe('runner-pass');

    let captured: SignalEnvelope | undefined;
    const exitCodes: number[] = [];
    const { lastFrame, unmount } = render(
      <SimRunner
        args={baseArgs()}
        setExitCode={(c) => exitCodes.push(c)}
        onEnvelope={(e) => {
          captured = e;
        }}
      />,
    );

    // Header (non-quiet, non-mini default) carries the tool title + recipe.
    await waitForFrame(lastFrame, 'Simulation Scenarios');
    expect(lastFrame()).toContain('Recipe');
    expect(lastFrame()).toContain('default');

    // The run completes; the summary shows the PASS verdict (ADR-0035).
    await waitForFrame(lastFrame, 'PASS');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PASS');

    // The completed run handed its envelope back to the composition root, and a
    // green run sets no failure exit code.
    expect(captured).toBeDefined();
    expect(captured?.tool).toBe('sim');
    expect(captured?.verdict.passed).toBe(true);
    expect(exitCodes).not.toContain(1);

    unmount();
  });

  it('yields a failing-verdict envelope when a scenario fails (host owns the exit)', async () => {
    enterSimScope();
    // A scenario whose run() rejects → recorded as failed.
    currentScenarioRegistry().register({
      id: 'runner-boom',
      name: 'runner-boom',
      description: 'boom',
      kind: 'load',
      tags: [],
      run: () => Promise.reject(new Error('kaboom')),
    });

    const exitCodes: number[] = [];
    let captured: SignalEnvelope | undefined;
    const { lastFrame, unmount } = render(
      <SimRunner
        args={baseArgs()}
        setExitCode={(c) => exitCodes.push(c)}
        onEnvelope={(e) => {
          captured = e;
        }}
      />,
    );

    await waitForFrame(lastFrame, 'FAIL');
    // ADR-0035: the runner no longer sets the findings exit — it hands the
    // envelope to the host (via onEnvelope → deliverSignals), which derives the
    // exit from envelope.verdict.passed. The runner itself sets no findings code.
    expect(exitCodes).not.toContain(1);
    expect(captured).toBeDefined();
    expect(captured?.verdict.summary.failed).toBe(1);
    // A thrown scenario fails its unit → the run verdict fails → the host exits 1.
    expect(captured?.verdict.passed).toBe(false);

    unmount();
  });

  it('renders the error phase and reports the config exit code for an unknown recipe', async () => {
    enterSimScope();
    registerProbe('runner-unused');

    const exitCodes: number[] = [];
    const { lastFrame, unmount } = render(
      <SimRunner
        args={baseArgs({ recipe: 'does-not-exist' })}
        setExitCode={(c) => exitCodes.push(c)}
      />,
    );

    await waitForFrame(lastFrame, 'does-not-exist');
    expect(lastFrame()).toContain('does-not-exist');
    // CONFIGURATION_ERROR === 2. The exit code is set in the same async tick as
    // the error-phase transition; poll briefly to absorb the React re-render.
    for (let i = 0; i < 50 && !exitCodes.includes(2); i++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    expect(exitCodes).toContain(2);

    unmount();
  });

  it('suppresses the banner/header block under --quiet but still shows the summary', async () => {
    enterSimScope();
    registerProbe('runner-quiet');

    const { lastFrame, unmount } = render(<SimRunner args={baseArgs({ quiet: true })} />);

    await waitForFrame(lastFrame, 'PASS');
    const frame = lastFrame() ?? '';
    // Quiet drops the run-header chrome…
    expect(frame).not.toContain('Simulation Scenarios');
    // …but keeps the PASS/FAIL verdict summary.
    expect(frame).toContain('PASS');

    unmount();
  });

  it('renders the mini banner update hint when an update is available', async () => {
    enterSimScope({
      ui: { bannerSize: 'mini', version: '3.0.0', update: '3.1.0' },
      projectContext: {
        cwd: process.cwd(),
        cwdExplicit: false,
        projectRoot: process.cwd(),
        configPath: undefined,
        walkedUp: 0,
        scope: 'none',
      },
    });
    registerProbe('runner-mini');

    const { lastFrame, unmount } = render(<SimRunner args={baseArgs()} />);

    // The mini banner surfaces the available update; the UpdateHint row renders.
    await waitForFrame(lastFrame, '3.1.0');
    expect(lastFrame()).toContain('3.1.0');

    unmount();
  });
});
