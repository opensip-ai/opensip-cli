/**
 * sim-runner — live-view entry for `opensip sim` via @opensip-cli/cli-live.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLiveView } from '@opensip-cli/cli-live';
import { type SignalEnvelope, type ToolOptions, type VerboseDetail } from '@opensip-cli/contracts';
import {
  runOffThreadOrInProcess,
  currentScope,
  liveEngineCorrelation,
  type LiveViewContext,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { buildSimulationSessionPayload } from '../persistence/session-payload.js';

import { SIMULATION_LAYOUT_KEY } from '../identity.js';
import { executeSim } from './sim.js';

import type { ProgressEvent, ProgressSurface } from '@opensip-cli/cli-ui';

const SIM_TOOL_TITLE = 'Simulation Scenarios';
const SIM_TOOL_DESCRIPTION = 'Running simulation scenarios against your codebase.';
const SIM_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading scenarios...' };
const SIM_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running scenarios...' };

type SimLiveArgs = ToolOptions & { readonly quiet?: boolean; readonly verbose?: boolean };

interface SimDoneShape {
  readonly envelope: SignalEnvelope;
  readonly verboseDetail?: VerboseDetail;
}

function executeSimWithProgress(
  args: SimLiveArgs,
  emit: (event: ProgressEvent) => void,
): ReturnType<typeof executeSim> {
  emit({ type: 'stage-start', stage: 'scenarios', label: 'Running scenarios...' });
  return executeSim(args, {
    onProgress: (completed, total) =>
      emit({ type: 'stage-progress', stage: 'scenarios', completed, total }),
  });
}

export interface RenderSimLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

export async function renderSimLive(
  args: SimLiveArgs,
  options?: RenderSimLiveOptions,
  liveContext?: LiveViewContext,
): Promise<ToolRunCompletion> {
  return runToolLiveView(
    {
      tool: 'simulation',
      meta: { title: SIM_TOOL_TITLE, description: SIM_TOOL_DESCRIPTION },
      surface: SIM_RUNNING_SURFACE,
      loadingSurface: SIM_LOADING_SURFACE,
      verbose: args.verbose === true,
      quiet: args.quiet === true,
      projectPath: args.cwd,
      walkedUp: currentScope()?.projectContext?.walkedUp,
      initialHeaderMetadata: [{ label: 'Recipe', value: args.recipe ?? 'default' }],
      produce: async (_emit, helpers) => {
        const specDir = mkdtempSync(join(tmpdir(), 'sim-worker-'));
        const specPath = join(specDir, 'spec.json');
        writeFileSync(specPath, JSON.stringify(args), 'utf8');
        const correlation = liveEngineCorrelation(currentScope()?.correlation);
        const run = runOffThreadOrInProcess<ProgressEvent, Awaited<ReturnType<typeof executeSim>>>({
          descriptor: {
            command: process.argv[1] ?? '',
            argv: ['sim-run-worker', specPath],
            ...(correlation ? { correlation } : {}),
          },
          inProcess: (workerEmit) => executeSimWithProgress(args, workerEmit),
        });

        helpers.setRunning(run.onProgress);

        let simResult: Awaited<ReturnType<typeof executeSim>>;
        try {
          simResult = await run.result;
        } finally {
          rmSync(specDir, { recursive: true, force: true });
        }

        const { result } = simResult;
        if (result.type === 'error') {
          const err = result;
          return {
            kind: 'error',
            message: err.message,
            exitCode: err.exitCode,
            ...(err.suggestion === undefined ? {} : { suggestion: err.suggestion }),
          };
        }

        const done: SimDoneShape = {
          envelope: result.envelope,
          verboseDetail: result.verboseDetail,
        };
        const findingsGroups =
          done.verboseDetail?.kind === 'findings' && done.verboseDetail.groups.length > 0
            ? done.verboseDetail.groups
            : undefined;

        return {
          kind: 'done',
          done: {
            summary: {
              passed: done.envelope.verdict.passed,
              errors: done.envelope.verdict.summary.errors,
              warnings: done.envelope.verdict.summary.warnings,
            },
            ...(findingsGroups === undefined ? {} : { verboseFindings: findingsGroups }),
          },
          envelope: done.envelope,
          session: {
            tool: SIMULATION_LAYOUT_KEY,
            cwd: args.cwd,
            recipe: done.envelope.recipe,
            score: done.envelope.verdict.score,
            passed: done.envelope.verdict.passed,
            payload: buildSimulationSessionPayload(done.envelope),
          },
        };
      },
    },
    {
      setExitCode: options?.setExitCode,
      liveContext,
    },
  );
}
