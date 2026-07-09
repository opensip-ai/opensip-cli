import {
  EXIT_CODES,
  deriveOutcome,
  type SignalEnvelope,
  type StoredRun,
  type StoredRunStep,
  type StoredRunVerdictSummary,
  type StoredSession,
} from "@opensip-cli/contracts";
import {
  commandProducesVerdict,
  currentLogger,
  currentScope,
  generatePrefixedId,
  readPackageVersion,
  type CommandMountContext,
  type CommandSpec,
  type ToolRunCompletion,
} from "@opensip-cli/core";
import { RunRepo, SessionRepo } from "@opensip-cli/session-store";

import { manifestVersionFor } from "../bootstrap/declared-inputs.js";
import {
  currentSuiteRunContext,
  type RunActionHooks,
} from "../bootstrap/run-plane.js";

import {
  projectEnvelopeEvidence,
  projectLedgerArgs,
} from "./run-ledger-projection.js";

import type { DataStore } from "@opensip-cli/datastore";

const CLI_VERSION = readPackageVersion(import.meta.url);

export interface PersistStandaloneRunInput<TCtx extends CommandMountContext> {
  readonly spec: CommandSpec<unknown, TCtx>;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly positionals: readonly unknown[];
  readonly ctx: TCtx;
  readonly hooks: RunActionHooks;
  readonly result?: unknown;
}

export function persistStandaloneRun<TCtx extends CommandMountContext>(
  input: PersistStandaloneRunInput<TCtx>,
): void {
  if (shouldSkipStandaloneRun(input)) return;

  const log = currentLogger();
  const scope = currentScope();
  const datastore = resolveDatastore(scope, log);
  if (datastore === undefined) return;

  try {
    const projection = buildStandaloneLedgerProjection(
      input,
      datastore,
      scope?.runId,
    );
    const { run, step, missingEvidence, sessionId, tool, command } = projection;
    new RunRepo(datastore).saveRunWithSteps(run, [step]);
    log.info?.({
      evt: "cli.run-ledger.standalone_recorded",
      module: "cli:standalone-run-ledger",
      runId: run.id,
      tool,
      command,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    if (missingEvidence) {
      log.warn?.({
        evt: "cli.run-ledger.standalone_missing_evidence",
        module: "cli:standalone-run-ledger",
        runId: run.id,
        tool,
        command,
        msg: "Verdict-producing command completed without a persisted session or signal envelope.",
      });
    }
  } catch (error) {
    log.warn?.({
      evt: "cli.run-ledger.standalone_record_failed",
      module: "cli:standalone-run-ledger",
      command: commandLabel(input.spec),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldSkipStandaloneRun<TCtx extends CommandMountContext>(
  input: PersistStandaloneRunInput<TCtx>,
): boolean {
  return (
    !commandProducesVerdict(input.spec) ||
    currentSuiteRunContext() !== undefined ||
    isNonRunMode(input.opts)
  );
}

function resolveDatastore(
  scope: ReturnType<typeof currentScope>,
  log: ReturnType<typeof currentLogger>,
): DataStore | undefined {
  try {
    return scope?.datastore() as DataStore | undefined;
  } catch (error) {
    log.debug?.({
      evt: "cli.run-ledger.datastore_unavailable",
      module: "cli:standalone-run-ledger",
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildStandaloneLedgerProjection<TCtx extends CommandMountContext>(
  input: PersistStandaloneRunInput<TCtx>,
  datastore: DataStore,
  correlationRunId: string | undefined,
): {
  readonly run: StoredRun;
  readonly step: StoredRunStep;
  readonly missingEvidence: boolean;
  readonly sessionId?: string;
  readonly tool: string;
  readonly command: string;
} {
  const sessionId = input.hooks.currentSessionId?.();
  const session =
    sessionId === undefined ? null : new SessionRepo(datastore).get(sessionId);
  const envelope = extractSignalEnvelope(input.result);
  const missingEvidence = session === null && envelope === undefined;
  const tool =
    session?.tool ?? envelope?.tool ?? input.spec.parent ?? input.spec.name;
  const command = commandLabel(input.spec);
  const exitCode = standaloneExitCode(
    input.ctx,
    missingEvidence,
    envelope,
    session,
  );
  const verdictSummary = verdictSummaryFrom(envelope, session);
  const outcome = standaloneOutcome({
    envelope,
    session,
    exitCode,
    missingEvidence,
  });
  const runId = generatePrefixedId("run");
  const timing = standaloneTiming(session, envelope);
  const effectiveArgs = projectLedgerArgs({
    ...input.opts,
    ...(input.positionals.length === 0 ? {} : { args: input.positionals }),
  });
  const engineVersion =
    session?.engineVersion ??
    envelope?.declaredInputs?.engineVersion ??
    manifestVersionFor(tool);
  const run: StoredRun = {
    id: runId,
    name: command,
    source: "implicit-tool",
    ...(correlationRunId === undefined ? {} : { correlationRunId }),
    cwd: session?.cwd ?? cwdFrom(input.opts),
    ...timing,
    exitCode,
    aggregate: {
      steps: 1,
      passed: outcome === "passed" ? 1 : 0,
      failed: outcome === "failed" ? 1 : 0,
      faulted: outcome === "faulted" ? 1 : 0,
      errors: verdictSummary?.errors ?? 0,
      warnings: verdictSummary?.warnings ?? 0,
    },
    cliVersion: session?.cliVersion ?? CLI_VERSION,
    ...(engineVersion === undefined
      ? {}
      : { engineVersions: { [tool]: engineVersion } }),
  };
  const step: StoredRunStep = {
    id: generatePrefixedId("step"),
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
    run,
    step,
    missingEvidence,
    ...(sessionId === undefined ? {} : { sessionId }),
    tool,
    command,
  };
}

function standaloneExitCode<TCtx extends CommandMountContext>(
  ctx: TCtx,
  missingEvidence: boolean,
  envelope: SignalEnvelope | undefined,
  session: StoredSession | null,
): number {
  const explicit = ctx.getExitCode?.();
  if (explicit !== undefined) return explicit;
  if (missingEvidence) return EXIT_CODES.RUNTIME_ERROR;
  if (envelope?.verdict.passed === false) return EXIT_CODES.RUNTIME_ERROR;
  if (session?.passed === false) return EXIT_CODES.RUNTIME_ERROR;
  return EXIT_CODES.SUCCESS;
}

function standaloneTiming(
  session: StoredSession | null,
  envelope: SignalEnvelope | undefined,
): Pick<StoredRun, "startedAt" | "completedAt" | "durationMs"> {
  const now = new Date().toISOString();
  const startedAt = session?.startedAt ?? envelope?.createdAt ?? now;
  const completedAt = session?.completedAt ?? now;
  const durationMs =
    session?.durationMs ??
    Math.max(
      0,
      new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    );
  return { startedAt, completedAt, durationMs };
}

function cwdFrom(opts: Readonly<Record<string, unknown>>): string {
  return typeof opts.cwd === "string" ? opts.cwd : process.cwd();
}

function commandLabel(spec: Pick<CommandSpec, "name" | "parent">): string {
  return spec.parent === undefined ? spec.name : `${spec.parent} ${spec.name}`;
}

function isNonRunMode(opts: Readonly<Record<string, unknown>>): boolean {
  return (
    opts.list === true ||
    opts.recipes === true ||
    (typeof opts.show === "string" && opts.show.length > 0)
  );
}

function extractSignalEnvelope(value: unknown): SignalEnvelope | undefined {
  if (isSignalEnvelope(value)) return value;
  if (value === null || typeof value !== "object") return undefined;
  const maybeCompletion = value as ToolRunCompletion & {
    readonly envelope?: unknown;
  };
  if (isSignalEnvelope(maybeCompletion.envelope))
    return maybeCompletion.envelope;
  const maybePresentation = value as {
    readonly result?: unknown;
    readonly envelope?: unknown;
  };
  if (isSignalEnvelope(maybePresentation.envelope))
    return maybePresentation.envelope;
  if (
    maybePresentation.result !== undefined &&
    typeof maybePresentation.result === "object" &&
    maybePresentation.result !== null
  ) {
    const nested = maybePresentation.result as { readonly envelope?: unknown };
    if (isSignalEnvelope(nested.envelope)) return nested.envelope;
  }
  return undefined;
}

function isSignalEnvelope(value: unknown): value is SignalEnvelope {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<SignalEnvelope>;
  return (
    typeof candidate.tool === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.verdict === "object" &&
    candidate.verdict !== null &&
    Array.isArray(candidate.units) &&
    Array.isArray(candidate.signals)
  );
}

function verdictSummaryFrom(
  envelope: SignalEnvelope | undefined,
  session: StoredSession | null,
): StoredRunVerdictSummary | undefined {
  if (envelope !== undefined) {
    return {
      passed: envelope.verdict.passed,
      errors: envelope.verdict.summary.errors,
      warnings: envelope.verdict.summary.warnings,
      findings: envelope.signals.length,
    };
  }
  const summary = sessionSummary(session);
  if (session === null && summary === undefined) return undefined;
  return {
    passed: session?.passed ?? false,
    errors: summary?.errors ?? 0,
    warnings: summary?.warnings ?? 0,
    findings:
      summary?.findings ?? (summary?.errors ?? 0) + (summary?.warnings ?? 0),
  };
}

function standaloneOutcome(input: {
  readonly envelope: SignalEnvelope | undefined;
  readonly session: StoredSession | null;
  readonly exitCode: number;
  readonly missingEvidence: boolean;
}): StoredRunStep["outcome"] {
  if (input.envelope !== undefined)
    return deriveOutcome(input.envelope.verdict);
  if (input.session?.runOutcome === "error") return "faulted";
  if (input.session !== null) return input.session.passed ? "passed" : "failed";
  if (input.missingEvidence) return "faulted";
  return input.exitCode === EXIT_CODES.SUCCESS ? "passed" : "failed";
}

function evidenceFrom(
  envelope: SignalEnvelope | undefined,
  session: StoredSession | null,
  missingEvidence: boolean,
): unknown {
  const envelopeEvidence = projectEnvelopeEvidence(envelope);
  if (envelopeEvidence !== undefined) return envelopeEvidence;
  if (session !== null) {
    return {
      sessionId: session.id,
      tool: session.tool,
      passed: session.passed,
      score: session.score,
      ...(session.runOutcome === undefined
        ? {}
        : { runOutcome: session.runOutcome }),
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      ...(() => {
        const summary = sessionSummary(session);
        return summary === undefined ? {} : { summary };
      })(),
    };
  }
  return missingEvidence ? { missing: "session-or-envelope" } : undefined;
}

function sessionSummary(session: StoredSession | null):
  | {
      readonly errors: number;
      readonly warnings: number;
      readonly findings: number;
    }
  | undefined {
  if (session?.payload === undefined || session.payload === null)
    return undefined;
  if (typeof session.payload !== "object") return undefined;
  const summary = (session.payload as { readonly summary?: unknown }).summary;
  if (summary === null || typeof summary !== "object") return undefined;
  const record = summary as Readonly<Record<string, unknown>>;
  const errors = finiteNumber(record.errors);
  const warnings = finiteNumber(record.warnings);
  const total = finiteNumber(record.total);
  if (errors === undefined && warnings === undefined && total === undefined)
    return undefined;
  return {
    errors: errors ?? 0,
    warnings: warnings ?? 0,
    findings: (errors ?? 0) + (warnings ?? 0),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
