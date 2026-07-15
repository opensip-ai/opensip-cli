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

import {
  suiteContextLine,
  suiteReviewLine,
  suiteVerboseDetail,
} from '../../ui/views/suite-views.js';

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
    // §2 header: title + a stable metadata band (`Steps: N`) — the suite's own
    // description rides as the header description (blank ones are skipped).
    meta: {
      title: `Suite ${args.suiteInput.name}`,
      description: args.suiteInput.suite.description ?? '',
    },
    initialHeaderMetadata: [{ label: 'Steps', value: String(stages.length) }],
    surface: { shape: 'phases', stages },
    // §3 body: keep the completed checklist (✓ per step) visible in the final
    // frame — the suite's per-step outcome IS the body (no duplicate step list).
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
      // The suite renders through the STANDARD done sections (no custom body):
      // §4 the canonical RunSummary headline, a one-line review verdict under it
      // (`summaryNote`), and the per-step + risk tables only under `--verbose`
      // (`verboseExtra`). The per-step outcome list is §3 (the checklist above).
      const reviewLine =
        suiteContextLine(result.contextManifest) ?? suiteReviewLine(result.reviewBrief);
      return {
        kind: 'done',
        done: {
          summary: {
            passed: result.exitCode === 0,
            faulted: (result.aggregate?.faulted ?? 0) > 0,
            errors: result.aggregate?.errors ?? 0,
            warnings: result.aggregate?.warnings ?? 0,
            durationMs: result.durationMs,
          },
          ...(reviewLine === undefined ? {} : { summaryNote: reviewLine }),
          verboseExtra: suiteVerboseDetail(result),
        },
      };
    },
  };

  // Capture the live-view exit so a synthetic empty result keeps ADR-0020 taxonomy
  // (e.g. ConfigurationError → 2) instead of hard-coding 1 after glue.setExitCode.
  let liveExitCode = 1;
  const outerSetExit = args.glue?.setExitCode;
  const glue = {
    ...args.glue,
    setExitCode: (code: number) => {
      liveExitCode = code;
      outerSetExit?.(code);
    },
  };

  let completion: ToolRunCompletion;
  try {
    completion = await runToolLiveView(spec, glue);
  } catch (error) {
    // Live view may rethrow after painting; if produce never assigned, rethrow
    // the original error rather than inventing a secondary message.
    if (result === undefined) throw error;
    throw error;
  }
  // Live view catches produce throws, paints error, and sets exit — if produce
  // still left result unset, surface a structured empty failure instead of a
  // secondary generic Error that obscures diagnostics.
  if (result === undefined) {
    const empty: SuiteRunResult = {
      type: 'suite-run',
      suite: args.suiteInput.name,
      suiteRunId: '',
      durationMs: 0,
      exitCode: liveExitCode,
      steps: [],
      scope: { mode: 'full', source: 'fallback', notice: 'suite live produce did not complete' },
    };
    return { completion, result: empty };
  }
  return { completion, result };
}
