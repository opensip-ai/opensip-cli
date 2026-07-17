import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SystemError, TimeoutError } from '../errors.js';
import { type FileLockMetadata, withFileLock, withFileLockAsync } from '../file-lock.js';

import type {
  DerivedHostIdentity,
  ProcessIncarnationInspection,
  SafetyBiasedProcessInspector,
  SafetyBiasedProcessInspectorOptions,
} from '../host-process-identity.js';

interface HostProcessIdentityModule {
  readonly createSafetyBiasedProcessInspector: (
    options: SafetyBiasedProcessInspectorOptions,
  ) => SafetyBiasedProcessInspector;
  readonly defaultHostInstanceIdentity: () => string | undefined;
  readonly deriveHostIdentity: (
    hostnameValue: string,
    hostInstanceIdentity: string | undefined,
  ) => DerivedHostIdentity;
  readonly inspectProcessIncarnation: (pid: number) => ProcessIncarnationInspection;
}

const processProbe = vi.hoisted(() => ({
  calls: new Map<number, number>(),
  inspect: undefined as
    | ((
        pid: number,
      ) =>
        | { readonly status: 'present'; readonly identity: string }
        | { readonly status: 'absent' }
        | { readonly status: 'unknown' })
    | undefined,
}));

vi.mock('../host-process-identity.js', async (importOriginal) => {
  const actual = await importOriginal<HostProcessIdentityModule>();
  return {
    ...actual,
    inspectProcessIncarnation: (pid: number) => {
      processProbe.calls.set(pid, (processProbe.calls.get(pid) ?? 0) + 1);
      return processProbe.inspect?.(pid) ?? actual.inspectProcessIncarnation(pid);
    },
  };
});

const POLICY = { waitMs: 200, staleMs: 50, heartbeatMs: 20 };

function captureOwnedMetadata(lockPath: string): FileLockMetadata {
  let metadata: FileLockMetadata | undefined;
  withFileLock(lockPath, { policy: POLICY, resource: 'runtime' }, () => {
    metadata = JSON.parse(readFileSync(lockPath, 'utf8')) as FileLockMetadata;
  });
  if (metadata === undefined) throw new TypeError('lock metadata was not captured');
  return metadata;
}

function asForeignOwner(metadata: FileLockMetadata, ownerToken: string): FileLockMetadata {
  return {
    ...metadata,
    ownerToken,
    hostInstanceIdentity: `${metadata.hostInstanceIdentity ?? 'unproven'}-other-boot`,
    hostIdentityProven: true,
  };
}

function publicationTempPath(lockPath: string, ownerToken: string): string {
  const digest = createHash('sha256')
    .update(`${basename(lockPath)}\0${ownerToken}`)
    .digest('hex')
    .slice(0, 32);
  return join(dirname(lockPath), `.opensip-lock-${digest}.publish`);
}

function replaceJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.test-replacement`;
  writeFileSync(tempPath, JSON.stringify(value), { mode: 0o600 });
  renameSync(tempPath, path);
}

describe('withFileLock', () => {
  let dir: string;

  afterEach(() => {
    processProbe.calls.clear();
    processProbe.inspect = undefined;
    vi.restoreAllMocks();
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

  it.runIf(process.platform !== 'win32')(
    'forces an exact owner-only mode under a restrictive umask',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'mode.lock');
      const previousUmask = process.umask(0o777);
      try {
        withFileLock(lockPath, { policy: POLICY, resource: 'runtime' }, () => {
          expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
        });
      } finally {
        process.umask(previousUmask);
      }
      expect(existsSync(lockPath)).toBe(false);
    },
  );

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

  it('removes its own partial create when metadata serialization fails', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'partial-create.lock');

    expect(() =>
      withFileLock(
        lockPath,
        {
          policy: POLICY,
          resource: 'runtime',
          runId: 1n as unknown as string,
        },
        () => 'never',
      ),
    ).toThrow(TypeError);
    expect(existsSync(lockPath)).toBe(false);

    expect(withFileLock(lockPath, { policy: POLICY, resource: 'runtime' }, () => 'recovered')).toBe(
      'recovered',
    );
  });

  it('rejects oversized UTF-8 metadata without stranding a lock', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'oversized.lock');
    let invoked = false;

    expect(() =>
      withFileLock(
        lockPath,
        {
          policy: POLICY,
          resource: 'runtime',
          command: '🙂'.repeat(2000),
        },
        () => {
          invoked = true;
        },
      ),
    ).toThrow(SystemError);
    expect(invoked).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite lock policy duration %s',
    (duration) => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'invalid-policy.lock');
      expect(() =>
        withFileLock(
          lockPath,
          {
            policy: { ...POLICY, waitMs: duration },
            resource: 'runtime',
          },
          () => 'never',
        ),
      ).toThrow(SystemError);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not unlink a replacement path while cleaning a failed partial create',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'partial-replaced.lock');
      writeFileSync(lockPath, '{"ownerToken":"original"}', 'utf8');
      const replacement = JSON.stringify({
        ownerToken: 'replacement-owner',
        pid: process.pid,
        hostname: hostname(),
        cwdBasename: 'replacement',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
      const replacingRunId = {
        toJSON: () => {
          unlinkSync(lockPath);
          writeFileSync(lockPath, replacement, 'utf8');
          throw new Error('metadata serialization failed');
        },
      };

      expect(() =>
        withFileLock(
          lockPath,
          {
            policy: POLICY,
            resource: 'runtime',
            runId: replacingRunId as unknown as string,
          },
          () => 'never',
        ),
      ).toThrow('metadata serialization failed');
      expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'recovers a dead owner only with a proven matching host instance',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'stale.lock');
      const owned = captureOwnedMetadata(lockPath);
      expect(owned.hostIdentityProven).toBe(true);
      expect(owned.processIncarnation).toBeTruthy();
      writeFileSync(
        lockPath,
        JSON.stringify({
          ...owned,
          ownerToken: 'old',
          pid: 999_999_999,
          acquiredAt: Date.now() - 60_000,
          lastHeartbeatAt: Date.now() - 60_000,
        }),
      );
      const events: string[] = [];
      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 500, staleMs: 1, heartbeatMs: 20 },
            resource: 'datastore',
            onEvent: (e) => {
              events.push(e.kind);
              if (e.kind === 'stale.recovered') throw new Error('observer failure');
            },
          },
          () => 'ok',
        ),
      ).toBe('ok');
      expect(events).toContain('stale.recovered');
    },
  );

  it('recovers an unchanged legacy record after a local-monotonic stale horizon', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'hostname-collision.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'legacy',
        pid: 999_999_999,
        hostname: hostname(),
        cwdBasename: 'tmp',
        acquiredAt: Date.now() - 60_000,
        lastHeartbeatAt: Date.now() - 60_000,
      }),
    );
    expect(
      withFileLock(
        lockPath,
        {
          policy: { waitMs: 150, staleMs: 10, heartbeatMs: 1 },
          resource: 'datastore',
        },
        () => 'recovered',
      ),
    ).toBe('recovered');
    expect(existsSync(lockPath)).toBe(false);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'does not mistake a reused live PID label for proof of legacy ownership',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'legacy-reused-pid.lock');
      writeFileSync(
        lockPath,
        JSON.stringify({
          ownerToken: 'legacy-reused-pid',
          pid: process.pid,
          hostname: hostname(),
          cwdBasename: 'tmp',
          acquiredAt: 1,
          lastHeartbeatAt: 1,
        }),
      );

      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 150, staleMs: 10, heartbeatMs: 1 },
            resource: 'datastore',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'does not let an extreme wall-clock jump accelerate foreign-owner recovery',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'foreign-host.lock');
      const owned = captureOwnedMetadata(lockPath);
      expect(owned.hostIdentityProven).toBe(true);
      writeFileSync(
        lockPath,
        JSON.stringify({
          ...owned,
          ownerToken: 'foreign',
          hostInstanceIdentity: `${owned.hostInstanceIdentity}-foreign`,
          acquiredAt: 1,
          lastHeartbeatAt: 1,
        }),
      );
      const wallNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(wallNow + 10 * 365 * 24 * 60 * 60 * 1000);

      const startedAt = performance.now();
      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 200, staleMs: 30, heartbeatMs: 1 },
            resource: 'datastore',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'settles a complete interrupted hard-link publication before recovery',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'interrupted-publication.lock');
      const captured = captureOwnedMetadata(lockPath);
      const owner = {
        ...asForeignOwner(captured, 'interrupted-publisher'),
        staleMs: 10,
      };
      const tempPath = publicationTempPath(lockPath, owner.ownerToken);
      writeFileSync(tempPath, JSON.stringify(owner), { mode: 0o600 });
      linkSync(tempPath, lockPath);
      expect(lstatSync(lockPath, { bigint: true }).nlink).toBe(2n);

      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 200, staleMs: 10, heartbeatMs: 1 },
            resource: 'runtime',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
      expect(existsSync(tempPath)).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'honors the longer owner-selected stale horizon',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'owner-horizon.lock');
      const owner = {
        ...asForeignOwner(captureOwnedMetadata(lockPath), 'long-owner-horizon'),
        staleMs: 130,
      };
      writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
      const startedAt = performance.now();

      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 300, staleMs: 10, heartbeatMs: 1 },
            resource: 'runtime',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(120);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'resets foreign-owner observation when an atomic heartbeat changes the snapshot',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'heartbeat-reset.lock');
      const owner = {
        ...asForeignOwner(captureOwnedMetadata(lockPath), 'heartbeating-foreign-owner'),
        staleMs: 80,
      };
      writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
      const startedAt = performance.now();
      const heartbeat = setTimeout(() => {
        replaceJsonAtomically(lockPath, {
          ...owner,
          lastHeartbeatAt: owner.lastHeartbeatAt + 1,
        });
      }, 65);

      try {
        await expect(
          withFileLockAsync(
            lockPath,
            {
              policy: { waitMs: 350, staleMs: 80, heartbeatMs: 5 },
              resource: 'runtime',
            },
            () => Promise.resolve('recovered'),
          ),
        ).resolves.toBe('recovered');
      } finally {
        clearTimeout(heartbeat);
      }
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(140);
    },
  );

  it('recovers exact unchanged corrupt metadata only after a monotonic horizon', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'unreadable-owner.lock');
    writeFileSync(lockPath, '{not-json');
    const wallNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(wallNow + 10 * 365 * 24 * 60 * 60 * 1000);

    const startedAt = performance.now();
    expect(
      withFileLock(
        lockPath,
        {
          policy: { waitMs: 200, staleMs: 30, heartbeatMs: 1 },
          resource: 'datastore',
        },
        () => 'recovered',
      ),
    ).toBe('recovered');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'bounds repeated live-owner process probes during contention',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'bounded-probes.lock');
      const pid = 800_000_101;
      const identity = 'test-live-process-incarnation';
      const owner = {
        ...captureOwnedMetadata(lockPath),
        ownerToken: 'live-probe-owner',
        pid,
        processIncarnation: identity,
      };
      writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
      processProbe.calls.clear();
      processProbe.inspect = (inspectedPid) =>
        inspectedPid === pid ? { status: 'present', identity } : { status: 'unknown' };

      expect(() =>
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 180, staleMs: 600_000, heartbeatMs: 20 },
            resource: 'datastore',
          },
          () => 'never',
        ),
      ).toThrow(TimeoutError);
      expect(processProbe.calls.get(pid)).toBe(1);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'freshly re-probes absence immediately before stale unlink',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'fresh-absence.lock');
      const pid = 800_000_102;
      const owner = {
        ...captureOwnedMetadata(lockPath),
        ownerToken: 'absent-probe-owner',
        pid,
        processIncarnation: 'departed-process-incarnation',
      };
      writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
      processProbe.calls.clear();
      processProbe.inspect = (inspectedPid) =>
        inspectedPid === pid ? { status: 'absent' } : { status: 'unknown' };

      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 100, staleMs: 10, heartbeatMs: 1 },
            resource: 'datastore',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
      expect(processProbe.calls.get(pid)).toBe(2);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'recovers a reused PID only when its proven process incarnation differs',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'pid-reuse.lock');
      const owned = captureOwnedMetadata(lockPath);
      expect(owned.hostIdentityProven).toBe(true);
      expect(owned.processIncarnation).toBeTruthy();
      writeFileSync(
        lockPath,
        JSON.stringify({
          ...owned,
          ownerToken: 'old-incarnation',
          processIncarnation: 'proven-different-process-incarnation',
          acquiredAt: Date.now() - 60_000,
          lastHeartbeatAt: Date.now() - 60_000,
        }),
      );

      expect(
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 200, staleMs: 1, heartbeatMs: 1 },
            resource: 'datastore',
          },
          () => 'recovered',
        ),
      ).toBe('recovered');
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'preserves an exact live process incarnation despite ancient heartbeat metadata',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'live-incarnation.lock');
      const owned = captureOwnedMetadata(lockPath);
      writeFileSync(
        lockPath,
        JSON.stringify({
          ...owned,
          ownerToken: 'still-live',
          acquiredAt: 1,
          lastHeartbeatAt: 1,
          staleMs: 10,
        }),
      );

      expect(() =>
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 100, staleMs: 10, heartbeatMs: 1 },
            resource: 'datastore',
          },
          () => 'never',
        ),
      ).toThrow(TimeoutError);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it('times out on live contention', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'contend.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'live',
        pid: process.pid,
        hostname: hostname(),
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

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'uses a monotonic sync deadline when wall time moves backward',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'backward-clock.lock');
      const owned = captureOwnedMetadata(lockPath);
      writeFileSync(lockPath, JSON.stringify({ ...owned, ownerToken: 'live-owner' }));

      let wallNow = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => {
        wallNow -= 60_000;
        return wallNow;
      });
      const startedAt = performance.now();

      expect(() =>
        withFileLock(
          lockPath,
          {
            policy: { waitMs: 40, staleMs: 600_000, heartbeatMs: 20 },
            resource: 'datastore',
          },
          () => 'never',
        ),
      ).toThrow(TimeoutError);
      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it('emits acquire.wait while polling live contention', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'wait.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'live',
        pid: process.pid,
        hostname: hostname(),
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
        () => Promise.resolve('never'),
      ),
    ).rejects.toThrow(TimeoutError);

    expect(events).toContain('acquire.wait');
  });

  it('firewalls lifecycle observer failures from results and timeout errors', () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'observer.lock');
    expect(
      withFileLock(
        lockPath,
        {
          policy: POLICY,
          resource: 'runtime',
          onEvent: () => {
            throw new Error('observer failed');
          },
        },
        () => 42,
      ),
    ).toBe(42);

    writeFileSync(
      lockPath,
      JSON.stringify({
        ownerToken: 'live',
        pid: process.pid,
        hostname: hostname(),
        cwdBasename: 'tmp',
        acquiredAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      }),
    );
    expect(() =>
      withFileLock(
        lockPath,
        {
          policy: { waitMs: 10, staleMs: 1000, heartbeatMs: 10 },
          resource: 'runtime',
          onEvent: () => {
            throw new Error('observer failed');
          },
        },
        () => 'never',
      ),
    ).toThrow(TimeoutError);
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed for a symlink lock without touching its target',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const target = join(dir, 'target.json');
      const lockPath = join(dir, 'symlink.lock');
      const original = JSON.stringify({
        ownerToken: 'old',
        pid: 999_999_999,
        hostname: 'other-host',
        cwdBasename: 'tmp',
        acquiredAt: Date.now() - 60_000,
        lastHeartbeatAt: Date.now() - 60_000,
      });
      writeFileSync(target, original);
      symlinkSync(target, lockPath);

      expect(() =>
        withFileLock(lockPath, { policy: POLICY, resource: 'runtime' }, () => 'never'),
      ).toThrow(SystemError);
      expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe(original);
    },
  );

  it('recovers structurally invalid metadata after an unchanged stale horizon', () => {
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

    expect(
      withFileLock(
        lockPath,
        {
          policy: { waitMs: 150, staleMs: 10, heartbeatMs: 1 },
          resource: 'datastore',
        },
        () => 'recovered',
      ),
    ).toBe('recovered');
  });
});

describe('withFileLockAsync', () => {
  let dir: string;

  afterEach(() => {
    processProbe.calls.clear();
    processProbe.inspect = undefined;
    vi.restoreAllMocks();
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
      () => Promise.resolve('ok'),
    );
    expect(out).toBe('ok');
    expect(() => readFileSync(lockPath, 'utf8')).toThrow();
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'uses a monotonic async deadline when wall time moves backward',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'async-backward-clock.lock');
      const owned = captureOwnedMetadata(lockPath);
      writeFileSync(lockPath, JSON.stringify({ ...owned, ownerToken: 'live-owner' }));

      let wallNow = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => {
        wallNow -= 60_000;
        return wallNow;
      });
      const startedAt = performance.now();

      await expect(
        withFileLockAsync(
          lockPath,
          {
            policy: { waitMs: 40, staleMs: 600_000, heartbeatMs: 20 },
            resource: 'artifact',
          },
          () => Promise.resolve('never'),
        ),
      ).rejects.toThrow(TimeoutError);
      expect(performance.now() - startedAt).toBeLessThan(2000);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps heartbeat writes at mode 0600 under a restrictive umask',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
      const lockPath = join(dir, 'heartbeat-mode.lock');
      const previousUmask = process.umask(0o777);
      try {
        await withFileLockAsync(
          lockPath,
          {
            policy: { waitMs: 200, staleMs: 100, heartbeatMs: 10 },
            resource: 'runtime',
          },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 35));
            expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
          },
        );
      } finally {
        process.umask(previousUmask);
      }
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it('publishes every heartbeat as a complete replacement inode', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'heartbeat-replacement.lock');

    await withFileLockAsync(
      lockPath,
      {
        policy: { waitMs: 200, staleMs: 100, heartbeatMs: 10 },
        resource: 'runtime',
      },
      async () => {
        const initial = lstatSync(lockPath, { bigint: true });
        expect(() => JSON.parse(readFileSync(lockPath, 'utf8'))).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 35));
        const afterHeartbeat = lstatSync(lockPath, { bigint: true });
        expect(afterHeartbeat.ino).not.toBe(initial.ino);
        expect(() => JSON.parse(readFileSync(lockPath, 'utf8'))).not.toThrow();
      },
    );
  });

  it('does not heartbeat into or release a successor lock', async () => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    const lockPath = join(dir, 'successor.lock');
    const replacement = JSON.stringify({
      ownerToken: 'replacement-owner',
      pid: process.pid,
      hostname: hostname(),
      cwdBasename: 'replacement',
      acquiredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });

    await withFileLockAsync(
      lockPath,
      {
        policy: { waitMs: 200, staleMs: 100, heartbeatMs: 10 },
        resource: 'runtime',
      },
      async () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, replacement, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 35));
        expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
      },
    );

    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
  });

  it('recovers malformed lock metadata on the async path after the horizon', async () => {
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
          policy: { waitMs: 150, staleMs: 10, heartbeatMs: 1 },
          resource: 'datastore',
        },
        () => Promise.resolve('recovered'),
      ),
    ).resolves.toBe('recovered');
  });
});
