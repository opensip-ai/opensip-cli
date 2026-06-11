import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DrizzleDataStore, DrizzleHandle } from '../data-store.js';

export function buildSqliteDataStore(dbPath: string): DrizzleDataStore {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: DrizzleHandle = drizzle(sqlite);
  let closed = false;
  return {
    db,
    close(): void {
      if (closed) return;
      sqlite.close();
      closed = true;
    },
    transaction<T>(fn: (tx: DrizzleHandle) => T): T {
      return db.transaction(fn);
    },
  };
}
