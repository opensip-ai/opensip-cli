import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSqliteDataStore,
  checkpointAndCloseSqlite,
  type SqliteLifecycleConnection,
} from '../backends/shared.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ds-shared-backend-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildSqliteDataStore', () => {
  it('runs write operations without a lock context on file-backed stores', () => {
    const path = join(tmp, 'unlocked.sqlite');
    const handle = buildSqliteDataStore(path);
    expect(handle.withWriteLock('probe', () => 42)).toBe(42);
    handle.close();
  });

  it('returns one idempotent lifecycle close proof', () => {
    const path = join(tmp, 'lifecycle.sqlite');
    const handle = buildSqliteDataStore(path);

    const first = handle.closeForLifecycle();
    const second = handle.closeForLifecycle();

    expect(first).toEqual({ checkpointed: true, closed: true });
    expect(second).toBe(first);
    expect(() => handle.close()).not.toThrow();
  });
});

class FaultingConnection implements SqliteLifecycleConnection {
  open = true;
  closeCalls = 0;

  constructor(
    private readonly checkpoint: 'ok' | 'busy' | 'throw',
    private readonly closeBehavior: 'ok' | 'throw',
  ) {}

  pragma(): unknown {
    if (this.checkpoint === 'throw') throw new Error('private checkpoint detail');
    return [{ busy: this.checkpoint === 'busy' ? 1 : 0, log: 1, checkpointed: 1 }];
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closeBehavior === 'throw') throw new Error('private close detail');
    this.open = false;
  }
}

describe('checkpointAndCloseSqlite', () => {
  it('always attempts close after checkpoint failure and omits native error details', () => {
    const sqlite = new FaultingConnection('throw', 'ok');

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });
    expect(sqlite.closeCalls).toBe(1);
  });

  it('distinguishes a busy checkpoint from a thrown checkpoint', () => {
    const sqlite = new FaultingConnection('busy', 'ok');

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-busy',
    });
  });

  it('does not claim closure when the native handle remains open', () => {
    const sqlite = new FaultingConnection('ok', 'throw');

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: true,
      closed: false,
      reason: 'native-close-failed',
    });
    expect(sqlite.closeCalls).toBe(1);
  });

  it('reports combined checkpoint and native-close failure', () => {
    const sqlite = new FaultingConnection('throw', 'throw');

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: false,
      closed: false,
      reason: 'checkpoint-and-close-failed',
    });
    expect(sqlite.closeCalls).toBe(1);
  });

  it.each([
    [],
    [{ busy: 0 }],
    [
      { busy: 0, log: 1, checkpointed: 1 },
      { busy: 0, log: 1, checkpointed: 1 },
    ],
    [{ busy: Number.NaN, log: 1, checkpointed: 1 }],
    [{ busy: 0, log: -2, checkpointed: 1 }],
  ])('does not accept a malformed checkpoint result as proof', (result) => {
    const sqlite: SqliteLifecycleConnection = {
      open: true,
      pragma: () => result,
      close(): void {
        Object.defineProperty(this, 'open', { value: false });
      },
    };

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });
  });

  it('accepts SQLite non-WAL sentinel counts when the checkpoint is not busy', () => {
    const sqlite: SqliteLifecycleConnection = {
      open: true,
      pragma: () => [{ busy: 0, log: -1, checkpointed: -1 }],
      close(): void {
        Object.defineProperty(this, 'open', { value: false });
      },
    };

    expect(checkpointAndCloseSqlite(sqlite)).toEqual({
      checkpointed: true,
      closed: true,
    });
  });
});
