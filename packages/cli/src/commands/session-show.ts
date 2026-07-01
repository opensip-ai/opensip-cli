import { EXIT_CODES } from '@opensip-cli/contracts';
import { buildToolIdentityIndex, currentScope, SystemError } from '@opensip-cli/core';
import { resolveAndReplaySession } from '@opensip-cli/session-store';

import { SessionReplayRegistry } from '../session-replay-registry.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-cli/contracts';
import type { ToolRegistry, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export interface ExecuteSessionShowOptions {
  readonly replayRegistry?: SessionReplayRegistry;
  readonly ref: string;
  readonly tool?: ToolShortId;
  /** Live tool registry — maps stored layout keys to canonical display names. */
  readonly registry?: ToolRegistry;
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
  const registry = opts.registry ?? currentScope()?.tools;
  const identityIndex = registry === undefined ? undefined : buildToolIdentityIndex(registry);
  const replayRegistry = opts.replayRegistry ?? SessionReplayRegistry.empty();
  // Resolve + replay + filter via the session-store read core (ADR-0084). The
  // per-tool replay closure is injected from the host's replay registry (which
  // carries the external-isolation gate); identity display + emission stay here.
  const outcome = await resolveAndReplaySession(datastore as DataStore, {
    ref: opts.ref,
    tool: opts.tool,
    replayFor: (tool) => replayRegistry.get(tool)?.replaySession,
    ...(opts.filters === undefined ? {} : { filters: opts.filters }),
  });
  if (!outcome.ok) {
    await emitSessionShowError(opts, outcome.reason, outcome.detail);
    return;
  }

  const { session, replay: filteredReplay, originalSignalCount } = outcome;

  if (opts.json === true) {
    const jsonPayload = sessionShowJson(
      session,
      filteredReplay,
      opts.filters,
      originalSignalCount,
      identityIndex,
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
      opts.setExitCode(EXIT_CODES.SUCCESS);
      return;
    }

    opts.emitJson(jsonPayload);
    return;
  }
  await opts.render(
    sessionReplayResult(session, filteredReplay, opts.filters, originalSignalCount, identityIndex),
  );
}

function canonicalToolForDisplay(
  tool: string,
  identityIndex?: ReturnType<typeof buildToolIdentityIndex>,
): string {
  return identityIndex === undefined ? tool : identityIndex.canonicalForStoredTool(tool);
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
  identityIndex?: ReturnType<typeof buildToolIdentityIndex>,
): CommandResult {
  return {
    type: 'session-replay',
    session: {
      id: session.id,
      tool: canonicalToolForDisplay(session.tool, identityIndex),
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      ...(session.recipe === undefined ? {} : { recipe: session.recipe }),
      score: session.score,
      passed: session.passed,
      ...(session.runOutcome === undefined ? {} : { runOutcome: session.runOutcome }),
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
  identityIndex?: ReturnType<typeof buildToolIdentityIndex>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: canonicalToolForDisplay(session.tool, identityIndex),
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      ...(session.runOutcome === undefined ? {} : { runOutcome: session.runOutcome }),
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
    opts.emitError({
      message: detail,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      code: reason,
    });
    return;
  }
  opts.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  await opts.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}
