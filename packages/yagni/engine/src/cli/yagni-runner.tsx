/**
 * yagni-runner — live-view entry for `opensip yagni` via @opensip-cli/cli-live.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLiveView } from '@opensip-cli/cli-live';
import { groupSignalsBySource } from '@opensip-cli/contracts';
import {
  isErrorSignal,
  currentScope,
  liveEngineCorrelation,
  runOffThreadOrInProcess,
  type LiveViewContext,
  type ToolCliContext,
} from '@opensip-cli/core';

import { YAGNI_DETECTORS } from '../detectors/registry.js';

import { executeYagni, type ExecuteYagniOptions } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';
import { buildYagniPresentationLines } from './yagni-presentation.js';
import { detectorDoneEvent, detectorLabel, detectorStartEvent } from './yagni-progress.js';

import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { LiveRunTableRow, ProgressEvent, ProgressSurface } from '@opensip-cli/cli-ui';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';

const YAGNI_TOOL_TITLE = 'YAGNI Audit';
const YAGNI_TOOL_DESCRIPTION = 'Scanning for speculative surface to remove.';

/**
 * Per-detector checklist (one phase per detector), mirroring graph's staged view.
 * Detectors run serially, so each row spins, completes with its duration, then the
 * next starts; a detector `planDetectors` excludes renders as a skipped row.
 */
const YAGNI_RUNNING_SURFACE: ProgressSurface = {
  shape: 'phases',
  stages: YAGNI_DETECTORS.map((d) => ({
    id: d.slug,
    label: detectorLabel(d.slug),
    runningDetail: 'Analyzing project...',
  })),
};
const YAGNI_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading detectors...' };

export { YAGNI_LIVE_VIEW_KEY } from '../identity.js';

export interface YagniLiveArgs {
  readonly cwd: string;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
}

export type YagniWorkerSpec = YagniLiveArgs;

function rowStatus(unit: UnitResult): LiveRunTableRow['status'] {
  if (unit.error !== undefined) return 'ERROR';
  return unit.passed ? 'PASS' : 'FAIL';
}

function envelopeToLiveRunTableRows(envelope: SignalEnvelope): LiveRunTableRow[] {
  const bySource = groupSignalsBySource(envelope.signals);
  return envelope.units.map((unit) => {
    const unitSignals = bySource.get(unit.slug) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const s of unitSignals) {
      if (isErrorSignal(s)) errors += 1;
      else warnings += 1;
    }
    return {
      unit: unit.slug,
      status: rowStatus(unit),
      errors,
      warnings,
      durationMs: unit.durationMs,
    };
  });
}

function buildExecuteOptions(
  args: YagniLiveArgs,
  config: ReturnType<typeof loadYagniConfig>,
  emit: (event: ProgressEvent) => void,
): ExecuteYagniOptions {
  return {
    cwd: args.cwd,
    config,
    minConfidence: args.minConfidence,
    detectors: args.detectors,
    categories: args.categories,
    includeTests: args.includeTests,
    pathRoots: args.pathRoots,
    onDetectorStart: (slug) => {
      emit(detectorStartEvent(slug));
    },
    onDetectorDone: (slug, durationMs) => {
      emit(detectorDoneEvent(slug, durationMs));
    },
    onDetectorsSkipped: (slugs) => {
      for (const slug of slugs) emit(detectorDoneEvent(slug, 0, 'skipped'));
    },
  };
}

export async function renderYagniLive(
  args: YagniLiveArgs,
  cli: ToolCliContext,
  liveContext?: LiveViewContext,
) {
  const config = loadYagniConfig(args.cwd);

  return runToolLiveView(
    {
      tool: 'yagni',
      meta: { title: YAGNI_TOOL_TITLE, description: YAGNI_TOOL_DESCRIPTION },
      surface: YAGNI_RUNNING_SURFACE,
      loadingSurface: YAGNI_LOADING_SURFACE,
      verbose: args.verbose === true,
      quiet: args.quiet === true,
      projectPath: args.cwd,
      walkedUp: currentScope()?.projectContext?.walkedUp,
      produce: async (emit, helpers) => {
        const specDir = mkdtempSync(join(tmpdir(), 'yagni-worker-'));
        const specPath = join(specDir, 'spec.json');
        writeFileSync(specPath, JSON.stringify(args), 'utf8');
        const correlation = liveEngineCorrelation(currentScope()?.correlation);
        const run = runOffThreadOrInProcess<
          ProgressEvent,
          Awaited<ReturnType<typeof executeYagni>>
        >({
          preferWorker: true,
          descriptor: {
            command: process.argv[1] ?? '',
            argv: ['yagni-run-worker', specPath],
            ...(correlation ? { correlation } : {}),
          },
          inProcess: (workerEmit) =>
            executeYagni(buildExecuteOptions(args, config, workerEmit), cli),
        });

        helpers.setRunning(run.onProgress);

        let outcome: Awaited<ReturnType<typeof executeYagni>>;
        try {
          outcome = await run.result;
        } finally {
          rmSync(specDir, { recursive: true, force: true });
        }
        const skippedDetectors = outcome.session.payload.summary.skippedDetectors;
        const verboseLines = buildYagniPresentationLines(
          outcome.envelope,
          args.cwd,
          skippedDetectors,
          args.verbose === true,
        );

        return {
          kind: 'done',
          done: {
            summary: {
              passed: outcome.envelope.verdict.passed,
              errors: outcome.envelope.verdict.summary.errors,
              warnings: outcome.envelope.verdict.summary.warnings,
            },
            ...(args.verbose === true
              ? {
                  verboseLines,
                  table: envelopeToLiveRunTableRows(outcome.envelope),
                }
              : {}),
          },
          envelope: outcome.envelope,
          session: outcome.session,
        };
      },
    },
    { liveContext, setExitCode: cli.setExitCode },
  );
}
