/**
 * history command — show run history
 */

import { loadSessions } from '@opensip-tools/contracts';

import type { HistoryResult } from '@opensip-tools/contracts';

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
