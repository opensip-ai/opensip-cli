/**
 * yagni-runner — live-view entry for `opensip yagni` via @opensip-cli/cli-live.
 */

import { runToolLiveView } from '@opensip-cli/cli-live';
import { groupSignalsBySource } from '@opensip-cli/contracts';
import {
  isErrorSignal,
  currentScope,
  type LiveViewContext,
  type ToolCliContext,
} from '@opensip-cli/core';

import { executeYagni, type ExecuteYagniOptions } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';
import { buildYagniPresentationLines } from './yagni-presentation.js';

import type { YagniGraphMode } from '../types/yagni-config.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { LiveRunTableRow, ProgressSurface } from '@opensip-cli/cli-ui';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';

const YAGNI_TOOL_TITLE = 'YAGNI Audit';
const YAGNI_TOOL_DESCRIPTION = 'Scanning for speculative surface to remove.';
const YAGNI_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running detectors...' };
const YAGNI_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading detectors...' };

export { YAGNI_LIVE_VIEW_KEY } from '../identity.js';

export interface YagniLiveArgs {
  readonly cwd: string;
  readonly verbose?: boolean;
  readonly quiet?: boolean;
  readonly graphMode: YagniGraphMode;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
}

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
        emit({ type: 'stage-start', stage: 'detectors', label: 'Running detectors...' });
        helpers.setRunning(() => {
          // In-process run — progress events flow through emit() directly.
        });

        const executeOpts: ExecuteYagniOptions = {
          cwd: args.cwd,
          config,
          graphMode: args.graphMode,
          minConfidence: args.minConfidence,
          detectors: args.detectors,
          categories: args.categories,
          includeTests: args.includeTests,
          pathRoots: args.pathRoots,
          onProgress: (completed, total) => {
            emit({ type: 'stage-progress', stage: 'detectors', completed, total });
          },
        };

        const outcome = await executeYagni(executeOpts, cli);
        const graphMode = outcome.session.payload.summary.graphMode ?? args.graphMode;
        const skippedDetectors = outcome.session.payload.summary.skippedDetectors;
        const verboseLines = buildYagniPresentationLines(
          outcome.envelope,
          args.cwd,
          graphMode,
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
