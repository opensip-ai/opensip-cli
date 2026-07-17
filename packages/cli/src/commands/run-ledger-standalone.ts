import {
  EXIT_CODES,
  type StoredRun,
  type StoredRunStep,
  type StoredRunVerdictSummary,
  type StoredSession,
} from '@opensip-cli/contracts';
import {
  commandProducesVerdict,
  generatePrefixedId,
  readPackageVersion,
  type CommandMountContext,
  type CommandSpec,
  type ToolRunCompletion,
} from '@opensip-cli/core';

import { manifestVersionFor } from '../bootstrap/declared-inputs.js';

import { projectLedgerArgs } from './run-ledger-projection.js';

import type { StagedEnvelopeEvidence } from '../bootstrap/run-plane.js';
import type { EvidenceBundleRun } from '@opensip-cli/session-store';

const CLI_VERSION = readPackageVersion(import.meta.url);

export interface ProjectStandaloneRunInput<TCtx extends CommandMountContext> {
  readonly spec: CommandSpec<unknown, TCtx>;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly positionals: readonly unknown[];
  readonly ctx: TCtx;
  readonly stagedSession?: StoredSession;
  readonly stagedEnvelope?: StagedEnvelopeEvidence;
  readonly correlationRunId?: string;
  /** A separately proven delegated child already owns the authoritative row. */
  readonly skipDelegatedSupervisor?: boolean;
  readonly suppressParent?: boolean;
}

export interface StandaloneRunProjection {
  readonly evidence: EvidenceBundleRun;
  readonly missingEvidence: boolean;
  readonly sessionId?: string;
  readonly tool: string;
  readonly command: string;
}

/**
 * Pure parent projection over evidence already staged by the host. This module
 * performs no datastore reads or writes: the command finalizer sends the
 * returned Run/RunStep beside the staged Session to one atomic bundle commit.
 */
export function projectStandaloneRun<TCtx extends CommandMountContext>(
  input: ProjectStandaloneRunInput<TCtx>,
): StandaloneRunProjection | undefined {
  if (
    input.skipDelegatedSupervisor === true ||
    !commandProducesVerdict(input.spec) ||
    input.suppressParent === true ||
    isNonRunMode(input.opts)
  ) {
    return undefined;
  }

  const session = input.stagedSession ?? null;
  const sessionId = session?.id;
  const envelope = input.stagedEnvelope;
  const missingEvidence = session === null && envelope === undefined;
  const tool = session?.tool ?? envelope?.tool ?? input.spec.parent ?? input.spec.name;
  const command = commandLabel(input.spec);
  const exitCode = standaloneExitCode(input.ctx, missingEvidence, envelope, session);
  const verdictSummary = verdictSummaryFrom(envelope, session);
  const outcome = standaloneOutcome({
    envelope,
    session,
    exitCode,
    missingEvidence,
  });
  const runId = generatePrefixedId('run');
  const timing = standaloneTiming(session, envelope);
  const effectiveArgs = projectLedgerArgs({
    ...input.opts,
    ...(input.positionals.length === 0 ? {} : { args: input.positionals }),
  });
  const engineVersion =
    session?.engineVersion ?? envelope?.engineVersion ?? manifestVersionFor(tool);
  const run: StoredRun = {
    id: runId,
    name: command,
    source: 'implicit-tool',
    ...(input.correlationRunId === undefined ? {} : { correlationRunId: input.correlationRunId }),
    cwd: session?.cwd ?? cwdFrom(input.opts),
    ...timing,
    exitCode,
    aggregate: {
      steps: 1,
      passed: outcome === 'passed' ? 1 : 0,
      failed: outcome === 'failed' ? 1 : 0,
      faulted: outcome === 'faulted' ? 1 : 0,
      errors: verdictSummary?.errors ?? 0,
      warnings: verdictSummary?.warnings ?? 0,
    },
    cliVersion: session?.cliVersion ?? CLI_VERSION,
    ...(engineVersion === undefined ? {} : { engineVersions: { [tool]: engineVersion } }),
  };
  const step: StoredRunStep = {
    id: generatePrefixedId('step'),
    runId,
    logicalStepKey: `0:${tool}:${command}`,
    ordinal: 0,
    attempt: 1,
    tool,
    command,
    stableId: tool,
    ...(effectiveArgs === undefined ? {} : { effectiveArgs }),
    exitCode,
    outcome,
    durationMs: timing.durationMs,
    ...(verdictSummary === undefined ? {} : { verdictSummary }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(() => {
      const evidence = evidenceFrom(envelope, session, missingEvidence);
      return evidence === undefined ? {} : { evidence };
    })(),
  };
  return {
    evidence: { run, steps: [step] },
    missingEvidence,
    ...(sessionId === undefined ? {} : { sessionId }),
    tool,
    command,
  };
}

export function isDelegatedCompletion(value: unknown): value is ToolRunCompletion {
  const execution = (value as ToolRunCompletion | null)?.execution;
  return (
    value !== null &&
    typeof value === 'object' &&
    execution?.kind === 'delegated' &&
    typeof execution.startedAt === 'string'
  );
}

export function commandLabel(spec: Pick<CommandSpec, 'name' | 'parent'>): string {
  return spec.parent === undefined ? spec.name : `${spec.parent} ${spec.name}`;
}

function standaloneExitCode<TCtx extends CommandMountContext>(
  ctx: TCtx,
  missingEvidence: boolean,
  envelope: StagedEnvelopeEvidence | undefined,
  session: StoredSession | null,
): number {
  const explicit = ctx.getExitCode?.();
  if (explicit !== undefined) return explicit;
  if (missingEvidence) return EXIT_CODES.RUNTIME_ERROR;
  if (envelope?.passed === false) return EXIT_CODES.RUNTIME_ERROR;
  if (session?.passed === false) return EXIT_CODES.RUNTIME_ERROR;
  return EXIT_CODES.SUCCESS;
}

function standaloneTiming(
  session: StoredSession | null,
  envelope: StagedEnvelopeEvidence | undefined,
): Pick<StoredRun, 'startedAt' | 'completedAt' | 'durationMs'> {
  const now = new Date().toISOString();
  const startedAt = session?.startedAt ?? envelope?.createdAt ?? now;
  const completedAt = session?.completedAt ?? now;
  const durationMs =
    session?.durationMs ??
    Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  return { startedAt, completedAt, durationMs };
}

function cwdFrom(opts: Readonly<Record<string, unknown>>): string {
  return typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
}

function isNonRunMode(opts: Readonly<Record<string, unknown>>): boolean {
  return (
    opts.list === true ||
    opts.recipes === true ||
    (typeof opts.show === 'string' && opts.show.length > 0)
  );
}

function verdictSummaryFrom(
  envelope: StagedEnvelopeEvidence | undefined,
  session: StoredSession | null,
): StoredRunVerdictSummary | undefined {
  if (envelope !== undefined) {
    return {
      passed: envelope.passed,
      errors: envelope.errors,
      warnings: envelope.warnings,
      findings: envelope.findings,
    };
  }
  const summary = sessionSummary(session);
  if (session === null && summary === undefined) return undefined;
  return {
    passed: session?.passed ?? false,
    errors: summary?.errors ?? 0,
    warnings: summary?.warnings ?? 0,
    findings: summary?.findings ?? (summary?.errors ?? 0) + (summary?.warnings ?? 0),
  };
}

function standaloneOutcome(input: {
  readonly envelope: StagedEnvelopeEvidence | undefined;
  readonly session: StoredSession | null;
  readonly exitCode: number;
  readonly missingEvidence: boolean;
}): StoredRunStep['outcome'] {
  if (input.envelope !== undefined) {
    if (input.envelope.faulted) return 'faulted';
    return input.envelope.passed ? 'passed' : 'failed';
  }
  if (input.session?.runOutcome === 'error') return 'faulted';
  if (input.session !== null) return input.session.passed ? 'passed' : 'failed';
  if (input.missingEvidence) return 'faulted';
  return input.exitCode === EXIT_CODES.SUCCESS ? 'passed' : 'failed';
}

function evidenceFrom(
  envelope: StagedEnvelopeEvidence | undefined,
  session: StoredSession | null,
  missingEvidence: boolean,
): unknown {
  if (envelope !== undefined) return envelope.evidence;
  if (session !== null) {
    return {
      sessionId: session.id,
      tool: session.tool,
      passed: session.passed,
      score: session.score,
      ...(session.runOutcome === undefined ? {} : { runOutcome: session.runOutcome }),
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      ...(() => {
        const summary = sessionSummary(session);
        return summary === undefined ? {} : { summary };
      })(),
    };
  }
  return missingEvidence ? { missing: 'session-or-envelope' } : undefined;
}

function sessionSummary(session: StoredSession | null):
  | {
      readonly errors: number;
      readonly warnings: number;
      readonly findings: number;
    }
  | undefined {
  if (session?.payload === undefined || session.payload === null) return undefined;
  if (typeof session.payload !== 'object') return undefined;
  const summary = (session.payload as { readonly summary?: unknown }).summary;
  if (summary === null || typeof summary !== 'object') return undefined;
  const record = summary as Readonly<Record<string, unknown>>;
  const errors = finiteNumber(record.errors);
  const warnings = finiteNumber(record.warnings);
  const total = finiteNumber(record.total);
  if (errors === undefined && warnings === undefined && total === undefined) return undefined;
  return {
    errors: errors ?? 0,
    warnings: warnings ?? 0,
    findings: (errors ?? 0) + (warnings ?? 0),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
