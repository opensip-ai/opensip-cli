import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SystemError, TimeoutError } from '../errors.js';
import { withFileLock, withFileLockAsync } from '../file-lock.js';

const POLICY = { waitMs: 200, staleMs: 50, heartbeatMs: 20 };

describe('withFileLock', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, runs fn, and releases the lockfile', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'test.lock');
    const events: string[] = [];
    const out = withFileLock(
      lockPath,
      {
        policy: POLICY,
        resource: 'datastore',
        operation: 'test.op',
        onEvent: (e) => events.push(e.kind),
      },
      () => 42,
    );
    expect(out).toBe(42);
    expect(events).toContain('acquire.start');
    expect(events).toContain('acquire.complete');
    expect(() => readFileSync(lockPath, 'utf8')).toThrow();
  });

  it('cleans up the lockfile when fn throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'throw.lock');
    expect(() =>
      withFileLock(lockPath, { policy: POLICY, resource: 'artifact' }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(() => readFileSync(lockPath, 'utf8')).toThrow();
  });

  it('recovers a stale lock when owner pid is gone', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'stale.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'old',
        pid: 999_999_999,
        hostname: 'gone',
        cwdBasename: 'tmp',
        acquiredAt: Date.now() - 60_000,
        lastHeartbeatAt: Date.now() - 60_000,
      }),
    );
    const events: string[] = [];
    withFileLock(
      lockPath,
      {
        policy: { waitMs: 500, staleMs: 1, heartbeatMs: 20 },
        resource: 'datastore',
        onEvent: (e) => events.push(e.kind),
      },
      () => 'ok',
    );
    expect(events).toContain('stale.recovered');
  });

  it('times out on live contention', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'contend.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'live',
        pid: process.pid,
        hostname: 'local',
        cwdBasename: 'tmp',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      }),
    );
    expect(() =>
      withFileLock(
        lockPath,
        {
          policy: { waitMs: 50, staleMs: 600_000, heartbeatMs: 20 },
          resource: 'datastore',
        },
        () => 'x',
      ),
    ).toThrow(TimeoutError);
  });

  it('emits acquire.wait while polling live contention', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'wait.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'live',
        pid: process.pid,
        hostname: 'local',
        cwdBasename: 'tmp',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      }),
    );
    const events: string[] = [];

    await expect(
      withFileLockAsync(
        lockPath,
        {
          policy: { waitMs: 150, staleMs: 600_000, heartbeatMs: 20 },
          resource: 'datastore',
          onEvent: (e) => events.push(e.kind),
        },
        async () => 'never',
      ),
    ).rejects.toThrow(TimeoutError);

    expect(events).toContain('acquire.wait');
  });

  it('rejects malformed lock metadata that cannot be recovered', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'malformed.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: '',
        pid: process.pid,
        hostname: 'local',
        cwdBasename: 'tmp',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      }),
    );

    expect(() =>
      withFileLock(
        lockPath,
        { policy: { waitMs: 50, staleMs: 600_000, heartbeatMs: 20 }, resource: 'datastore' },
        () => 'x',
      ),
    ).toThrow(SystemError);
  });
});

describe('withFileLockAsync', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, awaits fn, and releases the lockfile', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'async.lock');
    const out = await withFileLockAsync(
      lockPath,
      {
        policy: POLICY,
        resource: 'artifact',
        operation: 'artifact.write',
      },
      async () => 'ok',
    );
    expect(out).toBe('ok');
    expect(() => readFileSync(lockPath, 'utf8')).toThrow();
  });

  it('rejects malformed lock metadata on the async path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'async-malformed.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: '',
        pid: process.pid,
        hostname: 'local',
        cwdBasename: 'tmp',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      }),
    );

    await expect(
      withFileLockAsync(
        lockPath,
        {
          policy: { waitMs: 50, staleMs: 600_000, heartbeatMs: 20 },
          resource: 'datastore',
        },
        async () => 'x',
      ),
    ).rejects.toThrow(SystemError);
  });
});
