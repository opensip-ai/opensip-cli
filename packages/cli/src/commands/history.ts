/**
 * history command — show run history.
 *
 * v2: backed by SessionRepo over the project-local SQLite DataStore.
 * The CLI bootstrap opens the DataStore in `preAction`; this command
 * receives the constructed repo from its caller.
 */

import { SessionRepo } from '@opensip-tools/contracts';

import type { HistoryResult } from '@opensip-tools/contracts';
import type { DataStore } from '@opensip-tools/datastore';


export function showHistory(datastore: DataStore): HistoryResult {
  const repo = new SessionRepo(datastore);
  const sessions = [...repo.list()];
  return {
    type: 'history',
    sessions,
  };
}
