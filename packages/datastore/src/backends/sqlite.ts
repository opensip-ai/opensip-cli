import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DataStore } from '../data-store.js';
import { buildSqliteDataStore } from './shared.js';

export function openSqliteBackend(opts: { path: string }): DataStore {
  mkdirSync(dirname(opts.path), { recursive: true });
  return buildSqliteDataStore(opts.path);
}
