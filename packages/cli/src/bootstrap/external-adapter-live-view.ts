import { runToolLiveView, type LiveRunOutcome } from '@opensip-cli/cli-live';
import {
  buildFindingGroups,
  EXIT_CODES,
  isSignalEnvelope,
  mapToolErrorToExitCode,
} from '@opensip-cli/contracts';
import { ToolError, type ToolSource } from '@opensip-cli/core';

import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  requirePackageDir,
  runWorkerSpec,
} from './dispatch-fork-core.js';
import {
  replayResult,
  type DispatchHostCtx,
  type ReplayContext,
} from './dispatch-replay-result.js';

import type { DispatchExternalToolCommandArgs } from './dispatch-external-tool-command-types.js';
import type { ToolCommandWorkerSpec } from './tool-command-dispatch-types.js';
import type { ProgressEvent, ProgressSurface } from '@opensip-cli/cli-ui';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ExternalAdapterProgressEvent } from '@opensip-cli/external-tool-adapter';

const ADAPTER_PROGRESS_STAGES = [
  { id: 'resolve-binary', label: 'Resolve binary' },
  { id: 'prepare-artifacts', label: 'Prepare artifacts' },
  { id: 'run-scanner', label: 'Run scanner' },
  { id: 'ingest-report', label: 'Ingest report' },
  { id: 'store-evidence', label: 'Store evidence' },
  { id: 'deliver-signals', label: 'Deliver signals' },
] as const;

const ADAPTER_PROGRESS_SURFACE: ProgressSurface = {
  shape: 'phases',
  stages: ADAPTER_PROGRESS_STAGES,
};

const TOOL_TITLES: Readonly<Record<string, string>> = {
  gitleaks: 'Gitleaks',
  'osv-scanner': 'OSV-Scanner',
  osv: 'OSV-Scanner',
  trivy: 'Trivy',
};

export function shouldUseExternalAdapterLiveView(args: {
  readonly opts: Record<string, unknown>;
  readonly allowAdapterLiveView?: boolean;
}): boolean {
  if (args.allowAdapterLiveView !== true) return false;
  if (process.stdout.isTTY !== true) return false;
  if (args.opts.json === true) return false;
  if (args.opts.quiet === true) return false;
  if (args.opts.gateSave === true || args.opts.gateCompare === true) return false;
  return true;
}

function titleFor(toolId: string): string {
  const mapped = TOOL_TITLES[toolId];
  if (mapped !== undefined) return mapped;
  return toolId
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('-');
}

/** Fold optional counts into a human detail string ("32 signal(s)"), per spec 32. */
function detailFor(event: ExternalAdapterProgressEvent): string | undefined {
  if (event.detail !== undefined) return event.detail;
  if (event.signals !== undefined) {
    return `${String(event.signals)} signal${event.signals === 1 ? '' : 's'}`;
  }
  if (event.findings !== undefined) {
    return `${String(event.findings)} finding${event.findings === 1 ? '' : 's'}`;
  }
  return undefined;
}

function adapterEventToProgress(event: ExternalAdapterProgressEvent): ProgressEvent {
  const label =
    ADAPTER_PROGRESS_STAGES.find((stage) => stage.id === event.stage)?.label ?? event.stage;
  if (event.status === 'start') {
    return { type: 'stage-start', stage: event.stage, label };
  }
  const detail = detailFor(event);
  return {
    type: 'stage-done',
    stage: event.stage,
    durationMs: event.durationMs ?? 0,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Worker output crosses a process boundary, so the guard must cover every
 * field {@link doneFromResult} dereferences: the canonical envelope shape
 * (non-null verdict, signals/units arrays) plus the verdict summary the
 * live summary renders. The old local check accepted `verdict: null`
 * (`typeof null === 'object'`) and never checked `signals` — a malformed
 * worker result then threw a TypeError inside the live producer.
 */
function isEnvelope(value: unknown): value is SignalEnvelope {
  if (!isSignalEnvelope(value)) return false;
  const verdict = value.verdict as Partial<SignalEnvelope['verdict']>;
  return (
    typeof verdict.passed === 'boolean' &&
    typeof verdict.summary === 'object' &&
    verdict.summary !== null
  );
}

function binaryVersionFromSession(session: ToolCommandWorkerSpecResult['session']): string {
  const payload = session?.payload;
  const binary =
    typeof payload === 'object' && payload !== null
      ? (payload as { binary?: { version?: string | null } }).binary
      : undefined;
  return binary?.version ?? 'unresolved';
}

type ToolCommandWorkerSpecResult = Awaited<ReturnType<typeof runWorkerSpec>>;

function doneFromResult(result: ToolCommandWorkerSpecResult): LiveRunOutcome {
  const envelope = isEnvelope(result.completionEnvelope) ? result.completionEnvelope : undefined;
  if (envelope === undefined) {
    return {
      kind: 'error',
      message: 'external adapter worker did not return a scan envelope for live rendering',
      exitCode: 1,
    };
  }
  const findings =
    result.session !== undefined && envelope.signals.length > 0
      ? buildFindingGroups(envelope.units, envelope.signals)
      : undefined;
  return {
    kind: 'done',
    done: {
      summary: {
        passed: envelope.verdict.passed,
        errors: envelope.verdict.summary.errors,
        warnings: envelope.verdict.summary.warnings,
      },
      ...(findings === undefined || findings.length === 0 ? {} : { verboseFindings: findings }),
    },
    envelope,
    ...(result.session === undefined ? {} : { session: result.session }),
  };
}

function replayInput(args: DispatchExternalToolCommandArgs): ReplayContext {
  return {
    commandName: args.commandName,
    opts: { ...args.opts, _args: args.positionals },
    positionals: args.positionals,
  };
}

function workerSpec(args: DispatchExternalToolCommandArgs): ToolCommandWorkerSpec {
  return {
    toolId: args.provenance.id,
    toolPackageDir: requirePackageDir(args.provenance),
    source: args.provenance.source as Exclude<ToolSource, 'bundled'>,
    commandName: args.commandName,
    opts: args.opts,
    positionals: args.positionals,
    presentationMode: 'adapter-live',
    ...(args.config === undefined ? {} : { config: args.config }),
  };
}

export async function runExternalAdapterLiveView(
  args: DispatchExternalToolCommandArgs & { readonly ctx: DispatchHostCtx },
): Promise<void> {
  let workerResult: ToolCommandWorkerSpecResult | undefined;
  const toolId = args.provenance.id;
  const adapterPackage = args.provenance.packageName ?? toolId;
  const cwd = typeof args.opts.cwd === 'string' ? args.opts.cwd : process.cwd();

  await runToolLiveView(
    {
      tool: toolId,
      meta: {
        title: titleFor(toolId),
        description: 'External scanner adapter',
      },
      surface: ADAPTER_PROGRESS_SURFACE,
      verbose: args.opts.verbose === true,
      quiet: args.opts.quiet === true,
      progressOnDone: true,
      initialHeaderMetadata: [
        { label: 'Adapter', value: adapterPackage },
        { label: 'Binary', value: 'resolving' },
      ],
      projectPath: cwd,
      produce: async (emit, helpers) => {
        helpers.setRunning((callback) => {
          void callback;
        });
        try {
          workerResult = await runWorkerSpec({
            spec: workerSpec(args),
            ctx: args.ctx,
            cwd,
            ...(args.cliScript === undefined ? {} : { cliScript: args.cliScript }),
            timeoutMs: args.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
            onAdapterProgress: (event) => {
              emit(adapterEventToProgress(event));
            },
          });
        } catch (error) {
          return {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
            exitCode:
              error instanceof ToolError ? mapToolErrorToExitCode(error) : EXIT_CODES.RUNTIME_ERROR,
          };
        }

        helpers.setHeaderMetadata([
          { label: 'Adapter', value: adapterPackage },
          { label: 'Binary', value: binaryVersionFromSession(workerResult.session) },
        ]);
        return doneFromResult(workerResult);
      },
    },
    {
      setExitCode: args.ctx.setExitCode,
      ...(args.ctx.runSession ? { liveContext: { runSession: args.ctx.runSession } } : {}),
    },
  );

  if (workerResult !== undefined) {
    await replayResult(workerResult, args.ctx, replayInput(args));
  }
}
