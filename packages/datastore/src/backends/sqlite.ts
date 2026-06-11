import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildSqliteDataStore } from './shared.js';

import type { DrizzleDataStore } from '../data-store.js';

export function openSqliteBackend(opts: { path: string }): DrizzleDataStore {
  mkdirSync(dirname(opts.path), { recursive: true });
  return buildSqliteDataStore(opts.path);
}
