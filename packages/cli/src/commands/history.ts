/**
 * history command — show run history.
 */

import { buildToolIdentityIndex } from '@opensip-cli/core';
import { SessionRepo } from '@opensip-cli/session-store';

import type { HistoryResult, HistorySession, StoredSession } from '@opensip-cli/contracts';
import type { ToolRegistry, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

export interface ShowHistoryOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
  readonly summaryOnly?: boolean;
  /** When set, session list displays canonical tool names. */
  readonly registry?: ToolRegistry;
}

export function showHistory(datastore: DataStore, opts: ShowHistoryOptions = {}): HistoryResult {
  const repo = new SessionRepo(datastore);
  const identityIndex =
    opts.registry === undefined ? undefined : buildToolIdentityIndex(opts.registry);
  const sessions = repo
    .list(opts)
    .map((s) => toHistorySession(s, opts.summaryOnly, identityIndex));
  return {
    type: 'history',
    sessions,
  };
}

function toHistorySession(
  session: StoredSession,
  summaryOnly = false,
  identityIndex?: ReturnType<typeof buildToolIdentityIndex>,
): HistorySession {
  const summary = sessionSummary(session.payload);
  const { payload, tool, ...rest } = session;
  const displayTool =
    identityIndex === undefined ? tool : identityIndex.canonicalForStoredTool(tool);
  return {
    ...rest,
    tool: displayTool,
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