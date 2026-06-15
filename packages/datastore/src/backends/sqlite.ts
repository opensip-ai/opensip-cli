import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildSqliteDataStore } from './shared.js';

import type { SqliteBackendHandle } from '../data-store.js';

export function openSqliteBackend(opts: { path: string }): SqliteBackendHandle {
  mkdirSync(dirname(opts.path), { recursive: true });
  return buildSqliteDataStore(opts.path);
}
