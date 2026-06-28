/**
 * Read-only session-list projection — the pure core of the CLI `sessions list`
 * command (formerly `showHistory` in `packages/cli/src/commands/history.ts`).
 *
 * Re-homed here (ADR-0084) so `@opensip-cli/mcp` can list runs without importing
 * the composition root (`cli` is layer 6; a tool→cli edge would cycle). The CLI
 * command file is now a thin re-export over this function — `sessions list`
 * behavior is byte-for-byte unchanged.
 *
 * It uses `SessionRepo` internally (session-store is the sanctioned owner) but
 * exposes a read-only, DTO-returning signature — callers never see the repo
 * class. MCP imports this free function, never `SessionRepo`.
 */

import { buildToolIdentityIndex } from '@opensip-cli/core';

import { SessionRepo } from './session-repo.js';

import type { HistoryResult, HistorySession, StoredSession } from '@opensip-cli/contracts';
import type { ToolRegistry, ToolShortId } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

/** Filters for {@link listSessionSummaries}. */
export interface ListSessionSummariesOptions {
  readonly tool?: ToolShortId;
  readonly limit?: number;
  readonly summaryOnly?: boolean;
  /** When set, the session list displays canonical tool names. */
  readonly registry?: ToolRegistry;
}

/**
 * Read-only projection of stored sessions into a {@link HistoryResult} DTO — the
 * pure core of `opensip sessions list`, also consumed by `@opensip-cli/mcp`.
 * Applies the {@link ListSessionSummariesOptions} filters and, when a registry is
 * supplied, renders canonical tool names. Callers never see {@link SessionRepo}.
 */
export function listSessionSummaries(
  store: DataStore,
  opts: ListSessionSummariesOptions = {},
): HistoryResult {
  const repo = new SessionRepo(store);
  const identityIndex =
    opts.registry === undefined ? undefined : buildToolIdentityIndex(opts.registry);
  const sessions = repo.list(opts).map((s) => toHistorySession(s, opts.summaryOnly, identityIndex));
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
