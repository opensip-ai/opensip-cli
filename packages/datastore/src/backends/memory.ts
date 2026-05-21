import type { DataStore } from '../data-store.js';
import { buildSqliteDataStore } from './shared.js';

export function openMemoryBackend(): DataStore {
  return buildSqliteDataStore(':memory:');
}
