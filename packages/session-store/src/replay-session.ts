/**
 * Read-only session replay core — the pure resolve + replay + filter pipeline
 * extracted from the CLI `sessions show` command (`executeSessionShow` in
 * `packages/cli/src/commands/session-show.ts`).
 *
 * Re-homed here (ADR-0084) so `@opensip-cli/mcp` can replay a stored run without
 * importing the composition root. ONLY the pure data core moved: resolve the
 * reference, run the per-tool replay, apply agent filters → return a DTO. All
 * rendering / machine-output emission stays in the CLI command (which is now a
 * thin adapter over this function — `sessions show` behavior is byte-for-byte
 * unchanged).
 *
 * The per-tool replay itself is injected as {@link SessionReplayFn} (the host
 * owns the registry that maps a tool id → its replay; the external-isolation
 * variant stays in `cli`). This module names neither `SessionRepo` nor any
 * registry class — it takes a `DataStore` and a resolver function.
 */

import { applyAgentFilters } from '@opensip-cli/contracts';

import { resolveSession } from './resolve-session.js';

import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-cli/contracts';
import type { ToolSessionRecord, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * One tool's session replay, as the host resolves it. May be async (ADR-0054
 * M4-F): a bundled tool replays in-host; an external tool forks a worker.
 */
export type SessionReplayFn = (
  stored: ToolSessionRecord,
) => ToolSessionReplay<CommandResult> | Promise<ToolSessionReplay<CommandResult>>;

/** Options for {@link resolveAndReplaySession}. */
export interface ResolveAndReplayOptions {
  /** Session id, or the sentinel `'latest'` (which requires `tool`). */
  readonly ref: string;
  /** Tool for `'latest'`, or an optional id sanity check. */
  readonly tool?: ToolShortId;
  /** Resolve the replay closure for a stored session's tool id. */
  readonly replayFor: (tool: ToolShortId) => SessionReplayFn | undefined;
  /** Agent ergonomics filters applied to the replayed envelope (ADR-0085). */
  readonly filters?: readonly string[];
}

/**
 * The outcome of {@link resolveAndReplaySession}. The failure arm mirrors the
 * exact `reason` vocabulary `sessions show` surfaces (`not-found` / `wrong-tool`
 * / `ambiguous-latest` / `replay-unavailable` / `decode-error`) so the CLI
 * adapter routes each to its identical error emission with no drift.
 */
export type ReplaySessionOutcome =
  | { readonly ok: false; readonly reason: string; readonly detail: string }
  | {
      readonly ok: true;
      readonly session: StoredSession;
      /** The (possibly filtered) replay envelope projection. */
      readonly replay: ToolSessionReplay<CommandResult>;
      /** Signal count BEFORE any filter — for agent filter metadata. */
      readonly originalSignalCount: number;
    };

/**
 * Resolve a session reference, replay it via the injected per-tool replay, and
 * apply agent filters. Never throws across the domain boundary — every failure
 * is a structured `{ ok: false, reason, detail }` outcome.
 */
export async function resolveAndReplaySession(
  store: DataStore,
  opts: ResolveAndReplayOptions,
): Promise<ReplaySessionOutcome> {
  const resolved = resolveSession(store, { ref: opts.ref, tool: opts.tool });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, detail: resolved.detail };
  }

  const replayFn = opts.replayFor(resolved.session.tool);
  if (replayFn === undefined) {
    return {
      ok: false,
      reason: 'replay-unavailable',
      detail: `session replay is not available for ${resolved.session.tool}`,
    };
  }

  let replay: ToolSessionReplay<CommandResult>;
  try {
    // ADR-0054 M4-F: replay may be ASYNC — a bundled tool resolves in-host; an
    // external tool forks a worker. A corrupt/legacy payload surfaces as a
    // structured `decode-error` outcome, never a thrown error or silent empty.
    replay = await replayFn(resolved.session);
  } catch (error) {
    return {
      ok: false,
      reason: 'decode-error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const originalSignalCount = replay.envelope.signals.length;
  const filtered = opts.filters?.length
    ? { ...replay, envelope: applyAgentFilters(replay.envelope, opts.filters).envelope }
    : replay;

  return { ok: true, session: resolved.session, replay: filtered, originalSignalCount };
}
