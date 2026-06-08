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
  readonly emitJson?: CliCommandsContext['emitJson'];
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
    await emitSessionShowError(
      opts,
      'decode-error',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  if (opts.json === true) {
    emitJson(opts, sessionShowJson(resolved.session, replay));
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
  opts.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  if (opts.json === true) {
    emitJson(opts, { error: detail, reason });
    return;
  }
  await opts.render({
    type: 'error',
    message: detail,
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}

function emitJson(opts: Pick<ExecuteSessionShowOptions, 'emitJson'>, value: unknown): void {
  if (opts.emitJson !== undefined) {
    opts.emitJson(value);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
