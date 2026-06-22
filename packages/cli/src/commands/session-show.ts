import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentScope, SystemError } from '@opensip-cli/core';
import { resolveSession } from '@opensip-cli/session-store';

import { SessionReplayRegistry } from '../session-replay-registry.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export interface ExecuteSessionShowOptions {
  readonly replayRegistry?: SessionReplayRegistry;
  readonly ref: string;
  readonly tool?: ToolShortId;
  readonly json?: boolean;
  /** Agent ergonomics filters (from --filter, repeatable). See Phase 1 plan. */
  readonly filters?: string[];
  /** With json: request the inner payload (session + envelope + metadata) without outer wrapper. */
  readonly raw?: boolean;
  readonly render: CliCommandsContext['render'];
  /** Success machine-output seam — wraps the value in a `CommandOutcome`. */
  readonly emitJson: (value: unknown) => void;
  /**
   * RAW_STREAM seam — emits the bare, unwrapped payload (the `--raw` agent
   * path). The host binds this to `ctx.emitRaw`; the actual stdout write lives
   * in the single `renderRaw` seam, not here.
   */
  readonly emitRaw: (value: unknown) => void;
  /** Structured-error machine-output seam (launch, §5.5). */
  readonly emitError: CliCommandsContext['emitError'];
  readonly setExitCode: CliCommandsContext['setExitCode'];
}

export async function executeSessionShow(opts: ExecuteSessionShowOptions): Promise<void> {
  const scope = currentScope();
  if (!scope) {
    throw new SystemError(
      'executeSessionShow called before RunScope was entered. ' +
        'All host command paths (including sessions show) must run inside an entered scope ' +
        '(pre-action-hook constructs and enters; see host-planes-scope-seams-hygiene plan Phase 2).',
      { code: 'SYSTEM.SCOPE.NOT_ENTERED' },
    );
  }
  const datastore = scope.datastore();
  if (datastore == null) {
    throw new SystemError(
      'Datastore not available via scope for session show (project scope commands must have an open datastore thunk).',
      { code: 'SYSTEM.SCOPE.DATASTORE_UNAVAILABLE' },
    );
  }
  const resolved = resolveSession(datastore as DataStore, { ref: opts.ref, tool: opts.tool });
  if (!resolved.ok) {
    await emitSessionShowError(opts, resolved.reason, resolved.detail);
    return;
  }

  const contribution = (opts.replayRegistry ?? SessionReplayRegistry.empty()).get(
    resolved.session.tool,
  );
  if (contribution === undefined) {
    await emitSessionShowError(
      opts,
      'replay-unavailable',
      `session replay is not available for ${resolved.session.tool}`,
    );
    return;
  }

  let replay: ToolSessionReplay<CommandResult>;
  try {
    // ADR-0054 M4-F: replaySession may be ASYNC — a BUNDLED tool resolves
    // synchronously (in-host closure); an EXTERNAL tool forks a hook worker (its
    // runtime never runs in-host). Await covers both.
    replay = await contribution.replaySession(resolved.session);
  } catch (error) {
    // @handles — a corrupt/legacy stored payload is surfaced to the caller as a
    // structured `decode-error` outcome (not swallowed); see emitSessionShowError.
    await emitSessionShowError(
      opts,
      'decode-error',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  // Apply agent filters (Phase 1) *after* tool replay but before host emission.
  // This keeps per-tool replays pure while enabling token-efficient, focused
  // historical results for agents. The resulting envelope remains a valid
  // (possibly filtered) SignalEnvelope.
  const originalSignalCount = replay.envelope.signals.length;
  const filteredReplay = opts.filters?.length
    ? applyFiltersToReplay(resolved.session, replay, opts.filters)
    : replay;

  if (opts.json === true) {
    const jsonPayload = sessionShowJson(
      resolved.session,
      filteredReplay,
      opts.filters,
      originalSignalCount,
    );

    if (opts.raw) {
      // Raw mode for agents: emit the core payload directly (bypassing the
      // standard CommandOutcome {kind, status, data, ...} wrapper). This gives
      // the smallest possible machine response containing the session metadata +
      // (filtered) envelope + hints. The declared RAW_STREAM output mode for the
      // 'sessions show' command spec (see host-subcommand-groups.ts) is backed by
      // the host `emitRaw` seam — the actual stdout write lives in `renderRaw`,
      // so this body routes through a documented seam, not a raw stdout bypass.
      opts.emitRaw(jsonPayload);
      opts.setExitCode(0);
      return;
    }

    opts.emitJson(jsonPayload);
    return;
  }
  await opts.render(
    sessionReplayResult(resolved.session, filteredReplay, opts.filters, originalSignalCount),
  );
}

/** Sort rank for `top:N` severity ordering: high (0) before medium (1) before low (2). */
function severityRank(severity: string): number {
  if (severity === 'high') return 0;
  if (severity === 'medium') return 1;
  return 2;
}

/**
 * Simple, host-side filter applicator for SignalEnvelope signals.
 * errors-only  => severity === 'high'
 * warnings-only => severity === 'medium'
 * top:<n>      => take first N after severity sort (high, medium, low) + stable order
 * Composable: errors-only + top:20 means top 20 errors.
 */
function applyFiltersToReplay(
  session: StoredSession,
  replay: ToolSessionReplay<CommandResult>,
  filters: string[],
): ToolSessionReplay<CommandResult> {
  const envelope = replay.envelope;
  let signals = [...envelope.signals];

  const hasErrorsOnly = filters.some((f) => f === 'errors-only' || f === 'high');
  const hasWarningsOnly = filters.some((f) => f === 'warnings-only' || f === 'medium');

  if (hasErrorsOnly && !hasWarningsOnly) {
    signals = signals.filter((s) => s.severity === 'high');
  } else if (hasWarningsOnly && !hasErrorsOnly) {
    signals = signals.filter((s) => s.severity === 'medium');
  }
  // If both or neither, no severity filter (top will still apply).

  // Apply top:N (last filter wins for simplicity; or take min if multiple).
  const topFilter = filters.find((f) => f.startsWith('top:'));
  if (topFilter) {
    const n = Number.parseInt(topFilter.split(':')[1] || '0', 10);
    if (Number.isFinite(n) && n > 0) {
      // Re-sort for "top": high first, then medium, low, preserving original relative order.
      signals = signals
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
          const so = severityRank(a.s.severity) - severityRank(b.s.severity);
          return so === 0 ? a.i - b.i : so;
        })
        .slice(0, n)
        .map((x) => x.s);
    }
  }

  const filteredEnvelope = { ...envelope, signals };

  return {
    ...replay,
    envelope: filteredEnvelope,
  };
}

/**
 * Build the tool-agnostic `session-replay` view result from a resolved session +
 * its replay. Renders uniformly across fit/graph/sim via the shared envelope
 * table (not each tool's live-run done-view), with no live-run footer.
 *
 * When filters are applied, the delivered envelope contains the subset and
 * we attach agent metadata (counts + filtersApplied). The outer session
 * verdict (score/passed) always reflects the *original* stored run.
 */
/**
 * Agent-ergonomics metadata attached when `--filter` narrowed the envelope:
 * which filters ran + the original/returned signal counts. Absent (all fields
 * undefined → spread to nothing) when no filter was applied.
 */
interface AgentFilterMeta {
  readonly filtersApplied?: string[];
  readonly originalSignalCount?: number;
  readonly returnedSignalCount?: number;
}

function agentFilterMeta(
  returnedSignalCount: number,
  filters?: string[],
  originalSignalCount?: number,
): AgentFilterMeta {
  if (!filters?.length || originalSignalCount == null) return {};
  return { filtersApplied: filters, originalSignalCount, returnedSignalCount };
}

function sessionReplayResult(
  session: StoredSession,
  replay: ToolSessionReplay<CommandResult>,
  filters?: string[],
  originalSignalCount?: number,
): CommandResult {
  return {
    type: 'session-replay',
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    envelope: replay.envelope,
    fidelity: replay.fidelity,
    ...agentFilterMeta(replay.envelope.signals.length, filters, originalSignalCount),
  };
}

function sessionShowJson(
  session: StoredSession,
  replay: ToolSessionReplay<CommandResult>,
  filters?: string[],
  originalSignalCount?: number,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    fidelity: replay.fidelity,
    envelope: replay.envelope,
    ...agentFilterMeta(replay.envelope.signals.length, filters, originalSignalCount),
  };
}

async function emitSessionShowError(
  opts: ExecuteSessionShowOptions,
  reason: string,
  detail: string,
): Promise<void> {
  if (opts.json === true) {
    // emitError sets the exit code itself (process exit == reported outcome).
    opts.emitError({ message: detail, exitCode: EXIT_CODES.CONFIGURATION_ERROR, code: reason });
    return;
  }
  opts.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await opts.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}
