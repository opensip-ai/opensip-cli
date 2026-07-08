/**
 * The suite live view — renders the whole suite through ONE `runToolLiveView`
 * shell (the same shell every tool uses): one banner, a `phases` checklist with
 * one row per step (○ pending → spinner running → ✓/✗ done), and the compact
 * aggregate as the done frame. The steps themselves run HEADLESS inside
 * `runSuite` (embedded-render), so the suite owns the entire visible surface.
 *
 * This is the "one way of running things" at the render layer: the suite is just
 * a run whose progress units are its steps.
 */

import { runToolLiveView } from '@opensip-cli/cli-live';

import { viewSuiteRun } from '../../ui/views/suite-views.js';

import { runSuite, type RunSuiteInput } from './orchestrator.js';

import type { HostGlue, LiveRunSpec } from '@opensip-cli/cli-live';
import type { ProgressStageDescriptor } from '@opensip-cli/cli-ui';
import type { SuiteRunResult } from '@opensip-cli/contracts';
import type { ToolRunCompletion } from '@opensip-cli/core';

const OUTCOME_WORD: Record<'passed' | 'failed' | 'faulted', string> = {
  passed: 'pass',
  failed: 'fail',
  faulted: 'fault',
};

export interface RenderSuiteLiveArgs {
  /** The `runSuite` input (the live view supplies `onStepEvent` itself). */
  readonly suiteInput: RunSuiteInput;
  /** One checklist label per step, index-aligned (already deduped/resolved). */
  readonly stepLabels: readonly string[];
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly projectPath?: string;
  readonly glue?: HostGlue;
}

/**
 * Run a suite through the live shell; returns the completion + the run result.
 *
 * @throws {Error} If `produce()` completes without `runSuite` yielding a result
 *   (an internal invariant violation — `produce` always runs to completion
 *   before `runToolLiveView` resolves, so `result` is always set on success).
 */
export async function renderSuiteLive(
  args: RenderSuiteLiveArgs,
): Promise<{ readonly completion: ToolRunCompletion; readonly result: SuiteRunResult }> {
  const stages: ProgressStageDescriptor[] = args.stepLabels.map((label, index) => ({
    id: String(index),
    label,
  }));
  let result: SuiteRunResult | undefined;

  const spec: LiveRunSpec = {
    tool: 'suite',
    meta: { title: `Suite ${args.suiteInput.name}`, description: 'Running suite steps' },
    surface: { shape: 'phases', stages },
    // Keep the completed checklist (✓ per step) visible in the final frame,
    // above the aggregate — the user sees which steps ran, then the summary.
    // (Also makes the checklist deterministic in non-TTY captured output.)
    progressOnDone: true,
    verbose: args.verbose,
    quiet: args.quiet,
    ...(args.projectPath === undefined ? {} : { projectPath: args.projectPath }),
    produce: async (emit, helpers) => {
      // Transition to the running checklist; step events flow through `emit`.
      helpers.setRunning(() => {
        // no external progress stream — the suite emits step events directly
      });
      result = await runSuite({
        ...args.suiteInput,
        onStepEvent: (event) => {
          if (event.phase === 'start') {
            emit({
              type: 'stage-start',
              stage: String(event.index),
              label: args.stepLabels[event.index] ?? '',
            });
          } else {
            emit({
              type: 'stage-done',
              stage: String(event.index),
              durationMs: event.summary.durationMs,
              detail: OUTCOME_WORD[event.summary.outcome],
            });
          }
        },
      });
      return {
        kind: 'done',
        // `summary` is unused when `body` is present, but the shape is required.
        done: {
          summary: {
            passed: result.exitCode === 0,
            errors: result.aggregate?.errors ?? 0,
            warnings: result.aggregate?.warnings ?? 0,
            durationMs: result.durationMs,
          },
          body: viewSuiteRun(result),
        },
      };
    },
  };

  const completion = await runToolLiveView(spec, args.glue ?? {});
  // `produce` always runs to completion before `runToolLiveView` resolves.
  if (result === undefined) {
    throw new Error('renderSuiteLive: suite produced no result');
  }
  return { completion, result };
}
