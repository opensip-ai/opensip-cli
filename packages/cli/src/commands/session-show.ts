import { EXIT_CODES } from '@opensip-tools/contracts';
import { resolveSession } from '@opensip-tools/session-store';

import { SessionReplayRegistry } from '../session-replay-registry.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-tools/contracts';
import type { ToolShortId } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface ExecuteSessionShowOptions {
  readonly datastore: DataStore;
  readonly replayRegistry?: SessionReplayRegistry;
  readonly ref: string;
  readonly tool?: ToolShortId;
  readonly json?: boolean;
  readonly render: CliCommandsContext['render'];
  /** Success machine-output seam — wraps the value in a `CommandOutcome`. */
  readonly emitJson: (value: unknown) => void;
  /** Structured-error machine-output seam (2.12.0, §5.5). */
  readonly emitError: CliCommandsContext['emitError'];
  readonly setExitCode: CliCommandsContext['setExitCode'];
}

export async function executeSessionShow(opts: ExecuteSessionShowOptions): Promise<void> {
  const resolved = resolveSession(opts.datastore, { ref: opts.ref, tool: opts.tool });
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
    replay = contribution.replaySession(resolved.session);
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

  if (opts.json === true) {
    opts.emitJson(sessionShowJson(resolved.session, replay));
    return;
  }
  await opts.render(replay.result);
}

function sessionShowJson(
  session: StoredSession,
  replay: ToolSessionReplay<CommandResult>,
): unknown {
  return {
    session: {
      id: session.id,
      tool: session.tool,
      timestamp: session.timestamp,
      recipe: session.recipe,
      cwd: session.cwd,
      score: session.score,
      passed: session.passed,
      durationMs: session.durationMs,
    },
    fidelity: replay.fidelity,
    envelope: replay.envelope,
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
