import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildSqliteDataStore } from './shared.js';

import type { DataStoreLockContext, SqliteBackendHandle } from '../data-store.js';

export function openSqliteBackend(opts: {
  path: string;
  lock?: DataStoreLockContext;
}): SqliteBackendHandle {
  mkdirSync(dirname(opts.path), { recursive: true });
  return buildSqliteDataStore(opts.path, opts.lock);
}
