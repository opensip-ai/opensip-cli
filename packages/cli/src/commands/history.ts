/**
 * history command — show run history.
 *
 * The read-only list projection was re-homed into `@opensip-cli/session-store`
 * (ADR-0084) so `@opensip-cli/mcp` can list runs without importing the
 * composition root. This module is now a thin adapter: it re-exports the
 * extracted function under the historical `showHistory` name so the command
 * registration + tests are unchanged.
 */

export {
  listSessionSummaries as showHistory,
  type ListSessionSummariesOptions as ShowHistoryOptions,
} from '@opensip-cli/session-store';
