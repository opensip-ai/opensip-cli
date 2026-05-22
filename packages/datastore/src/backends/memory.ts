import { buildSqliteDataStore } from './shared.js';

import type { DataStore } from '../data-store.js';

export function openMemoryBackend(): DataStore {
  return buildSqliteDataStore(':memory:');
}
