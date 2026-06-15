import { buildSqliteDataStore } from './shared.js';

import type { DrizzleDataStore } from '../data-store.js';

export function openMemoryBackend(): DrizzleDataStore {
  return buildSqliteDataStore(':memory:');
}
