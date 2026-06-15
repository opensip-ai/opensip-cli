/**
 * history command — show run history.
 *
 * Backed by SessionRepo over the project-local SQLite DataStore.
 * The CLI bootstrap opens the DataStore in `preAction`; this command
 * receives the constructed repo from its caller.
 */

import { SessionRepo } from '@opensip-cli/session-store';

import type { HistoryResult, HistorySession, StoredSession } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export interface ShowHistoryOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
  /** Agent ergonomics: drop the heavy per-session payload (keep showCommand + lightweight summary). */
  readonly summaryOnly?: boolean;
}

export function showHistory(datastore: DataStore, opts: ShowHistoryOptions = {}): HistoryResult {
  const repo = new SessionRepo(datastore);
  const sessions = repo.list(opts).map((s) => toHistorySession(s, opts.summaryOnly));
  return {
    type: 'history',
    sessions,
  };
}

function toHistorySession(session: StoredSession, summaryOnly = false): HistorySession {
  const summary = sessionSummary(session.payload);
  // In summary-only mode, drop the (potentially large) tool-owned payload for
  // agent "menu" use cases — the lightweight summary (if present) + showCommand
  // remain. `payload` is `readonly?`, so we omit it by spreading `rest` (without
  // payload) and adding `payload` back only when NOT summary-only — no mutation /
  // delete (which would need an `any` cast to bypass readonly).
  const { payload, ...rest } = session;
  return {
    ...rest,
    ...(summaryOnly ? {} : { payload }),
    ...(summary === undefined ? {} : { summary }),
    showCommand: `opensip sessions show ${session.id} --json`,
  };
}

function sessionSummary(payload: unknown): HistorySession['summary'] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const summary = (payload as { summary?: unknown }).summary;
  if (summary === null || typeof summary !== 'object') return undefined;
  const { total, passed, failed, errors, warnings } = summary as Record<string, unknown>;
  if (
    typeof total !== 'number' ||
    typeof passed !== 'number' ||
    typeof failed !== 'number' ||
    typeof errors !== 'number' ||
    typeof warnings !== 'number'
  ) {
    return undefined;
  }
  return { total, passed, failed, errors, warnings };
}
