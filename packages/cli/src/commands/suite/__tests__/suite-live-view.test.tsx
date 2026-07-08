/**
 * Integration test for the suite live view (`renderSuiteLive`). It mounts the
 * REAL `runToolLiveView` shell (Ink), so it proves the render wiring end to end:
 *   - step labels become the checklist stages,
 *   - `onStepEvent` bridges to progress events (spinner → ✓ per step),
 *   - the run result renders as the custom done body (the compact aggregate),
 *   - and `renderSuiteLive` returns the completion + the result.
 *
 * The orchestrator is mocked so this test exercises ONLY the render seam — real
 * step execution + the headless embedded-render contract are covered by the
 * orchestrator and `run-tool-live-view` / `render-embedded` tests.
 */

import { LanguageRegistry, RunScope, ToolRegistry, runWithScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSuiteLive } from '../suite-live-view.js';

import type { RunSuiteInput } from '../orchestrator.js';
import type { SuiteRunResult, SuiteStepSummary } from '@opensip-cli/contracts';
import type { RunActionHooks } from '../../../bootstrap/run-plane.js';
import type { ToolCliContext } from '@opensip-cli/core';

const ACT_GLOBAL = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_GLOBAL.IS_REACT_ACT_ENVIRONMENT = true;

const CANNED_RESULT: SuiteRunResult = {
  type: 'suite-run',
  suite: 'audit',
  suiteRunId: 'RUN_suite_live',
  exitCode: 0,
  durationMs: 12,
  scope: { mode: 'full', source: 'default' },
  aggregate: { steps: 2, passed: 2, failed: 0, faulted: 0, errors: 0, warnings: 0 },
  steps: [],
  verbose: false,
};

function stepSummary(tool: string, durationMs: number): SuiteStepSummary {
  return { tool, stableId: `${tool}-id`, command: tool, exitCode: 0, durationMs, outcome: 'passed' };
}

const { runSuiteMock } = vi.hoisted(() => ({ runSuiteMock: vi.fn() }));

vi.mock('../orchestrator.js', () => ({ runSuite: runSuiteMock }));

function makeScope(): RunScope {
  return new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    runId: 'RUN_suite_live_test',
  });
}

function minimalInput(): RunSuiteInput {
  // Every heavy dep below is unused because runSuite is mocked; the live view
  // only forwards `name`/`onStepEvent`.
  return {
    name: 'audit',
    suite: { steps: [] } as unknown as RunSuiteInput['suite'],
    tools: [],
    ctx: {} as unknown as ToolCliContext,
    runActionHooks: {} as unknown as RunActionHooks,
    suiteOpts: {},
  };
}

describe('renderSuiteLive', () => {
  const writes: string[] = [];

  beforeEach(() => {
    writes.length = 0;
    runSuiteMock.mockReset();
    runSuiteMock.mockImplementation((input: RunSuiteInput) => {
      // Drive the checklist: fire start + done for each of the two steps. With
      // `progressOnDone`, the completed checklist replays into the final frame,
      // so the step labels are captured deterministically (no running-frame
      // timing dependence).
      input.onStepEvent?.({ phase: 'start', index: 0 });
      input.onStepEvent?.({ phase: 'done', index: 0, summary: stepSummary('fitness', 5) });
      input.onStepEvent?.({ phase: 'start', index: 1 });
      input.onStepEvent?.({ phase: 'done', index: 1, summary: stepSummary('yagni', 7) });
      return Promise.resolve(CANNED_RESULT);
    });
    const original = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      writes.push(String(chunk));
      return original(chunk, ...args as []);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the step checklist and the aggregate done body, and returns the result', async () => {
    const setExitCode = vi.fn();
    const scope = makeScope();

    const { completion, result } = await runWithScope(scope, () =>
      renderSuiteLive({
        suiteInput: minimalInput(),
        stepLabels: ['fitness', 'yagni'],
        verbose: false,
        quiet: false,
        glue: { setExitCode },
      }),
    );

    const out = writes.join('');
    // The checklist stages come from stepLabels...
    expect(out).toContain('fitness');
    expect(out).toContain('yagni');
    // ...and the done body is the compact suite aggregate (viewSuiteRun).
    expect(out).toContain('Suite');
    expect(out).toContain('audit');
    expect(out).toContain('Exit:');

    // The wiring returns the run result + a completion, and the orchestrator ran once.
    expect(result).toBe(CANNED_RESULT);
    expect(completion).toBeDefined();
    expect(runSuiteMock).toHaveBeenCalledOnce();
  }, 10_000);
});
