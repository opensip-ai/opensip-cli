import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DrizzleHandle, SqliteBackendHandle } from '../data-store.js';

export function buildSqliteDataStore(dbPath: string): SqliteBackendHandle {
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
    readUserVersion(): number {
      // `{ simple: true }` returns the scalar (0 on a fresh DB) rather than a row array.
      return Number(sqlite.pragma('user_version', { simple: true }));
    },
    writeUserVersion(version: number): void {
      // PRAGMA does not accept bound parameters; the value is an integer we own,
      // so interpolating it is safe (and `Number(...)`-guarded by the type).
      sqlite.pragma(`user_version = ${version}`);
    },
  };
}
