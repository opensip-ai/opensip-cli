import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DrizzleHandle, SqliteBackendHandle } from '../data-store.js';

export function buildSqliteDataStore(dbPath: string): SqliteBackendHandle {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Single connection per process, but two concurrent `opensip` invocations can
  // contend on the same project DB. Wait briefly instead of throwing SQLITE_BUSY.
  sqlite.pragma('busy_timeout = 5000');
  const db: DrizzleHandle = drizzle(sqlite);
  let closed = false;
  return {
    db,
    close(): void {
      if (closed) return;
      // Fold the WAL back into the main DB and truncate the -wal/-shm sidecars so
      // they don't grow unbounded across runs (better-sqlite3 close() checkpoints,
      // but TRUNCATE also shrinks the file on disk).
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
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
