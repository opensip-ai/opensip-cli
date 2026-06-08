/**
 * history command — show run history.
 *
 * v2: backed by SessionRepo over the project-local SQLite DataStore.
 * The CLI bootstrap opens the DataStore in `preAction`; this command
 * receives the constructed repo from its caller.
 */

import { SessionRepo } from '@opensip-tools/session-store';

import type { HistoryResult, HistorySession, StoredSession } from '@opensip-tools/contracts';
import type { ToolShortId } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface ShowHistoryOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
}

export function showHistory(datastore: DataStore, opts: ShowHistoryOptions = {}): HistoryResult {
  const repo = new SessionRepo(datastore);
  const sessions = repo.list(opts).map(toHistorySession);
  return {
    type: 'history',
    sessions,
  };
}

function toHistorySession(session: StoredSession): HistorySession {
  const summary = sessionSummary(session.payload);
  return {
    ...session,
    ...(summary === undefined ? {} : { summary }),
    showCommand: `opensip-tools sessions show ${session.id} --json`,
  };
}

function sessionSummary(payload: unknown): HistorySession['summary'] | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const summary = (payload as { summary?: unknown }).summary;
  if (summary === null || typeof summary !== 'object') return undefined;
  const { total, passed, failed, errors, warnings } = summary as Record<string, unknown>;
  if (
    typeof total !== 'number'
    || typeof passed !== 'number'
    || typeof failed !== 'number'
    || typeof errors !== 'number'
    || typeof warnings !== 'number'
  ) {
    return undefined;
  }
  return { total, passed, failed, errors, warnings };
}
