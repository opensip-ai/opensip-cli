/**
 * history command — show run history
 */

import { loadSessions } from '@opensip-tools/cli-shared';

import type { HistoryResult } from '@opensip-tools/cli-shared';

// ---------------------------------------------------------------------------
// showHistory
// ---------------------------------------------------------------------------

export function showHistory(): HistoryResult {
  const sessions = loadSessions();
  return {
    type: 'history',
    sessions,
  };
}
