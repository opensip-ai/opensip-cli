import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  projectCoordinationKey,
  resolveCoordinationPaths,
  resolveEphemeralProjectIdentity,
  RUNTIME_PROMOTION_JOURNAL_FILE,
  USER_UNINSTALL_RECEIPT_FILE,
} from '../paths.js';
import {
  acquireGlobalRuntimeMaintenanceLease,
  acquireRuntimeAccessLease,
  acquireRuntimeExclusiveLease,
  acquireRuntimeReadLease,
  acquireUserStateReadLease,
  cleanupEmptyRuntimeLeaseKey,
  createRuntimeLeaseCoordinator,
  discardRuntimePromotionJournal,
  discardUserUninstallReceipt,
  inspectRuntimePromotionRecoveryHeader,
  inspectRuntimeLeaseState,
  inspectUserUninstallRecoveryHeader,
  listActiveRuntimeLeaseKeys,
  mutateAnchoredRecord,
  mutateRuntimePromotionJournal,
  mutateUserUninstallReceipt,
  readAnchoredRecord,
  readRuntimePromotionJournal,
  RUNTIME_RECOVERY_HEADER_VERSION,
  RUNTIME_RECOVERY_RECORD_MAX_BYTES,
  type RuntimeLease,
} from '../runtime-lease.js';

const POLICY = { waitMs: 2000, staleMs: 120, heartbeatMs: 30, pollMs: 2 };
const SHORT_POLICY = { ...POLICY, waitMs: 35 };

let home: string;
let project: string;
let otherProject: string;
let priorHome: string | undefined;
let leases: RuntimeLease[];

function track<T extends RuntimeLease>(lease: T): T {
  leases.push(lease);
  return lease;
}

function release(lease: RuntimeLease): void {
  lease.release();
  leases = leases.filter((candidate) => candidate !== lease);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test state');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not emit ${expected}: ${errors}`));
    }, timeoutMs);
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onErrorOutput = (chunk: Buffer) => {
      errors += chunk.toString('utf8');
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before ${expected} (code ${String(code)}): ${errors}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onErrorOutput);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onErrorOutput);
    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

function privateWrite(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function hostId(value: string, instanceIdentity?: string): string {
  const material =
    instanceIdentity === undefined
      ? `unproven:${value.normalize('NFC') || 'unknown-host'}`
      : `proven:${instanceIdentity}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function syntheticCoordinator(input: {
  readonly pid: number;
  readonly parentPid: number;
  readonly processIdentities: ReadonlyMap<number, string>;
  readonly tokenPrefix: string;
}) {
  let tokenSequence = 0;
  return createRuntimeLeaseCoordinator({
    pid: input.pid,
    parentPid: input.parentPid,
    hostname: () => 'delegated-reader-host',
    hostInstanceIdentity: () => 'delegated-reader-host-instance',
    inspectProcessIncarnation: (pid) => {
      const identity = input.processIdentities.get(pid);
      return identity === undefined
        ? ({ status: 'absent' } as const)
        : ({ status: 'present', identity } as const);
    },
    isProcessAlive: (pid) => input.processIdentities.has(pid),
    generateToken: () => `${input.tokenPrefix}-${(++tokenSequence).toString().padStart(8, '0')}`,
  });
}

function coreEntryPath(): string {
  return fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
}

function runtimeLeaseEntryPath(): string {
  return fileURLToPath(new URL('../../../dist/lib/runtime-lease.js', import.meta.url));
}

async function runBarrierWorkers(
  worker: string,
  count: number,
  ...arguments_: readonly string[]
): Promise<void> {
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, ['--input-type=module', '--eval', worker, ...arguments_]),
  );
  try {
    await Promise.all(children.map((child) => waitForChildOutput(child, 'READY\n', 30_000)));
    const completed = children.map((child) => waitForChildOutput(child, 'DONE\n', 60_000));
    for (const child of children) child.stdin.write('GO\n');
    await Promise.all(completed);
  } finally {
    await Promise.all(children.map((child) => stopChild(child)));
  }
}

function readerFixture(
  dimension: 'project' | 'user',
  ownerToken: string,
  sequence: number,
  references: readonly string[] = [sequence.toString(16).padStart(24, '0')],
): Record<string, unknown> {
  const now = Date.now();
  return {
    version: 1,
    dimension,
    refs: references.length,
    references,
    ownerToken,
    pid: process.pid,
    hostname: hostId('fixture-host'),
    hostIdentityProven: false,
    command: 'capacity-test',
    cwdBasename: 'fixture',
    acquiredAt: now,
    lastHeartbeatAt: now,
    staleMs: 60_000,
    sequence,
  };
}

async function createScaffold(): Promise<void> {
  const lease = await acquireRuntimeReadLease({
    projectDir: project,
    policy: POLICY,
  });
  lease.release();
  const paths = resolveCoordinationPaths();
  const projectPaths = paths.forProject(projectCoordinationKey(project));
  mkdirSync(projectPaths.projectCoordinationDir, { mode: 0o700 });
  mkdirSync(projectPaths.readersDir, { mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(projectPaths.projectCoordinationDir, 0o700);
    chmodSync(projectPaths.readersDir, 0o700);
  }
}

function promotionPath(): string {
  return resolveCoordinationPaths().forProject(projectCoordinationKey(project))
    .promotionJournalFile;
}

beforeEach(() => {
  priorHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'opensip-runtime-lease-home-'));
  process.env.HOME = home;
  project = mkdtempSync(join(tmpdir(), 'opensip-runtime-lease-project-'));
  otherProject = mkdtempSync(join(tmpdir(), 'opensip-runtime-lease-other-'));
  leases = [];
});

afterEach(() => {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    const lease = leases[index];
    try {
      lease.release();
    } catch {
      // Test cleanup cannot safely erase ambiguous coordination state.
    }
  }
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  rmSync(otherProject, { recursive: true, force: true });
});

describe('runtime lease coordination', () => {
  it('resolves coordination outside deletable user state and keeps generation identity separate', () => {
    const paths = resolveCoordinationPaths();
    const identity = resolveEphemeralProjectIdentity(project);

    expect(paths.coordinationDir).toBe(join(home, '.opensip-cli-coordination'));
    expect(paths.coordinationDir).not.toContain(`${join(home, '.opensip-cli')}/`);
    expect(identity.coordinationKey).toBe(projectCoordinationKey(project));
    expect(identity.cacheKey).not.toBe(identity.coordinationKey);
    expect(() => paths.forProject('../escape')).toThrow(
      expect.objectContaining({
        code: 'SYSTEM.RUNTIME_COORDINATION.INVALID_KEY',
      }),
    );
  });

  it('keeps live coordination intact when the deletable user-data root is removed', async () => {
    const userDataRoot = join(home, '.opensip-cli');
    mkdirSync(userDataRoot, { mode: 0o700 });
    privateWrite(join(userDataRoot, 'evidence.json'), { disposable: true });
    const lease = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const paths = resolveCoordinationPaths();

    rmSync(userDataRoot, { recursive: true });

    expect(existsSync(paths.coordinationDir)).toBe(true);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 1,
    });
    const reentrant = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: lease.ownerToken,
        policy: POLICY,
      }),
    );
    release(reentrant);
    release(lease);
  });

  it('allows multiple readers and exposes only bounded current-project state', async () => {
    const first = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const second = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));

    const state = await inspectRuntimeLeaseState(project);
    expect(state).toMatchObject({
      status: 'stable',
      projectReaders: 2,
      writer: 'none',
    });
    expect(await listActiveRuntimeLeaseKeys()).toEqual([first.coordinationKey]);

    release(first);
    release(second);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
    });
  });

  it('keeps valid and malformed promotion journals active for cache pruning', async () => {
    await createScaffold();
    const key = projectCoordinationKey(project);
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'prune-protection',
      state: 'closed',
    });
    expect(await listActiveRuntimeLeaseKeys()).toContain(key);

    writeFileSync(promotionPath(), '{malformed', {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(promotionPath(), 0o600);
    expect(await listActiveRuntimeLeaseKeys()).toContain(key);
  });

  it('fails cache-prune enumeration closed for global maintenance and uninstall recovery', async () => {
    await createScaffold();
    const writer = track(await acquireGlobalRuntimeMaintenanceLease({ policy: POLICY }));
    await expect(listActiveRuntimeLeaseKeys()).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    release(writer);

    privateWrite(resolveCoordinationPaths().userUninstallReceiptFile, {
      kind: 'user-uninstall',
      version: 1,
      operationId: 'prune-uninstall-recovery',
      state: 'closed',
    });
    await expect(listActiveRuntimeLeaseKeys()).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
  });

  it('repairs only a proven-empty project scaffold left by an interrupted transition', async () => {
    const otherLease = await acquireRuntimeReadLease({
      projectDir: otherProject,
      policy: POLICY,
    });
    otherLease.release();
    const paths = resolveCoordinationPaths();
    const projectPaths = paths.forProject(projectCoordinationKey(project));
    mkdirSync(projectPaths.projectCoordinationDir, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(projectPaths.projectCoordinationDir, 0o700);

    const lease = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );

    expect(lstatSync(projectPaths.readersDir).isDirectory()).toBe(true);
    expect(await listActiveRuntimeLeaseKeys()).toContain(lease.coordinationKey);
  });

  it('fails closed instead of repairing a non-empty incomplete project scaffold', async () => {
    const otherLease = await acquireRuntimeReadLease({
      projectDir: otherProject,
      policy: POLICY,
    });
    otherLease.release();
    const paths = resolveCoordinationPaths();
    const projectPaths = paths.forProject(projectCoordinationKey(project));
    mkdirSync(projectPaths.projectCoordinationDir, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(projectPaths.projectCoordinationDir, 0o700);
    privateWrite(join(projectPaths.projectCoordinationDir, 'unexpected'), {
      incomplete: true,
    });

    await expect(
      acquireRuntimeReadLease({
        projectDir: project,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    expect(existsSync(projectPaths.readersDir)).toBe(false);
  });

  it('keeps absent-state inspection strictly read-only', async () => {
    const paths = resolveCoordinationPaths();
    expect(existsSync(paths.coordinationDir)).toBe(false);

    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
      promotion: { status: 'absent' },
    });
    expect(existsSync(paths.coordinationDir)).toBe(false);
  });

  it('reports busy whenever a coordination transition mutex is present', async () => {
    await createScaffold();
    privateWrite(resolveCoordinationPaths().globalMutexFile, {
      ownerToken: 'inspection-transition-owner-0001',
      pid: process.pid,
      hostname: hostId(hostname()),
      hostIdentityProven: false,
      acquiredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      staleMs: 60_000,
    });

    await expect(inspectRuntimeLeaseState(project)).resolves.toEqual({
      status: 'busy',
      reason: 'changed-during-inspection',
    });
  });

  it.each([
    ['waitMs', Number.NaN],
    ['staleMs', Number.POSITIVE_INFINITY],
    ['heartbeatMs', Number.NEGATIVE_INFINITY],
    ['pollMs', Number.NaN],
  ] as const)('rejects non-finite %s policy values', async (field, value) => {
    await expect(
      acquireRuntimeReadLease({
        projectDir: project,
        policy: { [field]: value },
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.INVALID_POLICY',
    });
    expect(existsSync(resolveCoordinationPaths().coordinationDir)).toBe(false);
  });

  it('publishes writer intent before draining readers and blocks later readers', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const writerPromise = acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: POLICY,
    });
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'intent';
    });

    await expect(
      acquireRuntimeReadLease({ projectDir: project, policy: SHORT_POLICY }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });

    release(reader);
    const writer = track(await writerPromise);
    expect(writer.kind).toBe('runtime-exclusive');
  });

  it('queues same-key writers FIFO while allowing different project writers to overlap', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const order: string[] = [];
    const firstPromise = acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: { ...POLICY, waitMs: 15_000 },
      command: 'first',
    }).then((lease) => {
      order.push('first');
      return lease;
    });
    void firstPromise.catch(() => undefined);
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'intent';
    });
    const secondPromise = acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: { ...POLICY, waitMs: 15_000 },
      command: 'second',
    }).then((lease) => {
      order.push('second');
      return lease;
    });
    void secondPromise.catch(() => undefined);
    release(reader);
    const first = track(await firstPromise);
    expect(order).toEqual(['first']);

    const other = track(
      await acquireRuntimeExclusiveLease({
        projectDir: otherProject,
        policy: POLICY,
      }),
    );
    expect(other.coordinationKey).not.toBe(first.coordinationKey);
    release(first);
    track(await secondPromise);
    expect(order).toEqual(['first', 'second']);
  }, 30_000);

  it('lets a registered owner add the missing shared dimension ahead of a later global intent', async () => {
    const projectLease = track(
      await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    );
    const globalPromise = acquireGlobalRuntimeMaintenanceLease({
      policy: POLICY,
    });
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.globalWriter === 'intent';
    });

    const userLease = track(
      await acquireUserStateReadLease({
        ownerToken: projectLease.ownerToken,
        policy: POLICY,
      }),
    );
    expect(userLease.ownerToken).toBe(projectLease.ownerToken);
    release(userLease);
    release(projectLease);
    track(await globalPromise);
  });

  it('lets a direct child inherit a composite reader sequence ahead of a later writer', async () => {
    const parentPid = 410_001;
    const childPid = 410_002;
    const writerPid = 410_003;
    const identities = new Map([
      [parentPid, 'parent-incarnation'],
      [childPid, 'child-incarnation'],
      [writerPid, 'writer-incarnation'],
    ]);
    const parentCoordinator = syntheticCoordinator({
      pid: parentPid,
      parentPid: 1,
      processIdentities: identities,
      tokenPrefix: 'parent-delegation',
    });
    const childCoordinator = syntheticCoordinator({
      pid: childPid,
      parentPid,
      processIdentities: identities,
      tokenPrefix: 'child-delegation',
    });
    const writerCoordinator = syntheticCoordinator({
      pid: writerPid,
      parentPid: 1,
      processIdentities: identities,
      tokenPrefix: 'writer-delegation',
    });
    const parent = track(
      await parentCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: POLICY,
      }),
    );
    const writerEvents: string[] = [];
    const writerPromise = writerCoordinator.acquireGlobalRuntimeMaintenanceLease({
      policy: { ...POLICY, waitMs: 15_000 },
      onEvent: (event) => writerEvents.push(event.kind),
    });
    void writerPromise.catch(() => undefined);
    await waitUntil(() => writerEvents.includes('lease.acquire.wait'));

    const child = track(
      await childCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    );
    const paths = resolveCoordinationPaths();
    const projectReadersDir = paths.forProject(parent.coordinationKey!).readersDir;
    const parentRecord = JSON.parse(
      readFileSync(join(projectReadersDir, `reader-${parent.ownerToken}.json`), 'utf8'),
    ) as { sequence: number };
    const childProjectPath = join(projectReadersDir, `reader-${child.ownerToken}.json`);
    const childUserPath = join(paths.userReadersDir, `reader-${child.ownerToken}.json`);
    const childRecord = JSON.parse(readFileSync(childProjectPath, 'utf8')) as {
      sequence: number;
      pid: number;
    };
    expect(child.ownerToken).not.toBe(parent.ownerToken);
    expect(childRecord).toMatchObject({
      sequence: parentRecord.sequence,
      pid: childPid,
    });
    expect(existsSync(childUserPath)).toBe(true);

    release(parent);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(writerEvents).not.toContain('lease.acquire.complete');
    expect(existsSync(childProjectPath)).toBe(true);
    expect(existsSync(childUserPath)).toBe(true);

    release(child);
    expect(existsSync(childProjectPath)).toBe(false);
    expect(existsSync(childUserPath)).toBe(false);
    const writer = track(await writerPromise);
    expect(writerEvents).toContain('lease.acquire.complete');
    release(writer);
  }, 30_000);

  it('refuses parent inheritance across a writer that precedes the parent sequence', async () => {
    const parentPid = 420_001;
    const childPid = 420_002;
    const writerPid = 420_003;
    const identities = new Map([
      [parentPid, 'parent-earlier-writer-incarnation'],
      [childPid, 'child-earlier-writer-incarnation'],
      [writerPid, 'writer-earlier-writer-incarnation'],
    ]);
    const parentCoordinator = syntheticCoordinator({
      pid: parentPid,
      parentPid: 1,
      processIdentities: identities,
      tokenPrefix: 'parent-earlier',
    });
    const childCoordinator = syntheticCoordinator({
      pid: childPid,
      parentPid,
      processIdentities: identities,
      tokenPrefix: 'child-earlier',
    });
    const writerCoordinator = syntheticCoordinator({
      pid: writerPid,
      parentPid: 1,
      processIdentities: identities,
      tokenPrefix: 'writer-earlier',
    });
    const parent = track(
      await parentCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: POLICY,
      }),
    );
    const writerEvents: string[] = [];
    const writerPromise = writerCoordinator.acquireGlobalRuntimeMaintenanceLease({
      policy: { ...POLICY, waitMs: 15_000 },
      onEvent: (event) => writerEvents.push(event.kind),
    });
    void writerPromise.catch(() => undefined);
    await waitUntil(() => writerEvents.includes('lease.acquire.wait'));

    const paths = resolveCoordinationPaths();
    const projectReaderPath = join(
      paths.forProject(parent.coordinationKey!).readersDir,
      `reader-${parent.ownerToken}.json`,
    );
    const userReaderPath = join(paths.userReadersDir, `reader-${parent.ownerToken}.json`);
    for (const path of [projectReaderPath, userReaderPath]) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      privateWrite(path, { ...record, sequence: 3 });
    }

    const childOwnerToken = 'delegated-child-earlier-0001';
    await expect(
      childCoordinator.acquireRuntimeAccessLease({
        ownerToken: childOwnerToken,
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });
    expect(
      existsSync(
        join(
          paths.forProject(parent.coordinationKey!).readersDir,
          `reader-${childOwnerToken}.json`,
        ),
      ),
    ).toBe(false);
    expect(existsSync(join(paths.userReadersDir, `reader-${childOwnerToken}.json`))).toBe(false);

    release(parent);
    const writer = track(await writerPromise);
    release(writer);
  }, 30_000);

  it('requires host proof and uses a live-parent fallback when incarnation inspection is unavailable', async () => {
    // This case exercises identity posture, not stale-owner recovery. Keep its
    // synthetic parent comfortably live even when the monorepo suite briefly
    // starves heartbeat timers under heavy parallel load.
    const inheritancePolicy = {
      waitMs: 15_000,
      staleMs: 60_000,
      heartbeatMs: 1000,
      pollMs: 5,
    };
    const runCase = async (
      caseProject: string,
      identityPosture: 'unproven-host' | 'missing-incarnation',
      pidBase: number,
    ): Promise<void> => {
      const parentPid = pidBase + 1;
      const childPid = pidBase + 2;
      const writerPid = pidBase + 3;
      const identities = new Map([
        [parentPid, `${identityPosture}-parent-incarnation`],
        [childPid, `${identityPosture}-child-incarnation`],
        [writerPid, `${identityPosture}-writer-incarnation`],
      ]);
      let parentToken = 0;
      const parentCoordinator = createRuntimeLeaseCoordinator({
        pid: parentPid,
        parentPid: 1,
        hostname: () => `${identityPosture}-host`,
        hostInstanceIdentity:
          identityPosture === 'unproven-host'
            ? () => undefined
            : () => `${identityPosture}-host-instance`,
        inspectProcessIncarnation: (pid) => {
          if (identityPosture === 'missing-incarnation' && pid === parentPid) {
            return { status: 'unknown' } as const;
          }
          const identity = identities.get(pid);
          return identity === undefined
            ? ({ status: 'absent' } as const)
            : ({ status: 'present', identity } as const);
        },
        isProcessAlive: (pid) => identities.has(pid),
        generateToken: () =>
          `${identityPosture}-parent-${(++parentToken).toString().padStart(8, '0')}`,
      });
      let childToken = 0;
      const childCoordinator = createRuntimeLeaseCoordinator({
        pid: childPid,
        parentPid,
        hostname: () => `${identityPosture}-host`,
        hostInstanceIdentity:
          identityPosture === 'unproven-host'
            ? () => undefined
            : () => `${identityPosture}-host-instance`,
        inspectProcessIncarnation: (pid) => {
          if (identityPosture === 'missing-incarnation' && pid === parentPid) {
            return { status: 'unknown' } as const;
          }
          const identity = identities.get(pid);
          return identity === undefined
            ? ({ status: 'absent' } as const)
            : ({ status: 'present', identity } as const);
        },
        isProcessAlive: (pid) => identities.has(pid),
        generateToken: () =>
          `${identityPosture}-child-${(++childToken).toString().padStart(8, '0')}`,
      });
      const writerCoordinator = syntheticCoordinator({
        pid: writerPid,
        parentPid: 1,
        processIdentities: identities,
        tokenPrefix: `${identityPosture}-writer`,
      });
      const parent = track(
        await parentCoordinator.acquireRuntimeAccessLease({
          projectRead: { projectDir: caseProject },
          userStateRead: true,
          policy: inheritancePolicy,
        }),
      );
      const writerEvents: string[] = [];
      const writerPromise = writerCoordinator.acquireGlobalRuntimeMaintenanceLease({
        policy: { ...POLICY, waitMs: 15_000 },
        onEvent: (event) => writerEvents.push(event.kind),
      });
      void writerPromise.catch(() => undefined);
      await waitUntil(() => writerEvents.includes('lease.acquire.wait'));

      const acquireChild = () =>
        childCoordinator.acquireRuntimeAccessLease({
          projectRead: { projectDir: caseProject },
          userStateRead: true,
          inheritFromParent: true,
          policy: inheritancePolicy,
        });
      if (identityPosture === 'unproven-host') {
        await expect(acquireChild()).rejects.toMatchObject({
          code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
        });
      } else {
        const child = track(await acquireChild());
        expect(child.ownerToken).not.toBe(parent.ownerToken);
        release(child);
      }

      release(parent);
      const writer = track(await writerPromise);
      release(writer);
    };

    await runCase(project, 'unproven-host', 440_000);
    await runCase(otherProject, 'missing-incarnation', 450_000);
  }, 45_000);

  it('requires one unambiguous live same-host direct-parent composite reader', async () => {
    const parentPid = 430_001;
    const childPid = 430_002;
    const identities = new Map([
      [parentPid, 'parent-proof-incarnation'],
      [childPid, 'child-proof-incarnation'],
    ]);
    const parentCoordinator = syntheticCoordinator({
      pid: parentPid,
      parentPid: 1,
      processIdentities: identities,
      tokenPrefix: 'parent-proof',
    });
    const childCoordinator = syntheticCoordinator({
      pid: childPid,
      parentPid,
      processIdentities: identities,
      tokenPrefix: 'child-proof',
    });
    const parent = track(
      await parentCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: POLICY,
      }),
    );

    const ambiguousParent = track(
      await parentCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: POLICY,
      }),
    );
    await expect(
      childCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });
    release(ambiguousParent);

    const additionalUserParent = track(
      await parentCoordinator.acquireUserStateReadLease({ policy: POLICY }),
    );
    await expect(
      childCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });
    release(additionalUserParent);

    const projectOnlyParent = track(
      await parentCoordinator.acquireRuntimeReadLease({
        projectDir: otherProject,
        policy: POLICY,
      }),
    );
    await expect(
      childCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: otherProject },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });
    release(projectOnlyParent);

    const userOnlyParentPid = parentPid + 200;
    const userOnlyChildPid = childPid + 200;
    const userOnlyIdentities = new Map([
      [userOnlyParentPid, 'user-only-parent-incarnation'],
      [userOnlyChildPid, 'user-only-child-incarnation'],
      ...identities,
    ]);
    const userOnlyParentCoordinator = syntheticCoordinator({
      pid: userOnlyParentPid,
      parentPid: 1,
      processIdentities: userOnlyIdentities,
      tokenPrefix: 'user-only-parent',
    });
    const userOnlyChildCoordinator = syntheticCoordinator({
      pid: userOnlyChildPid,
      parentPid: userOnlyParentPid,
      processIdentities: userOnlyIdentities,
      tokenPrefix: 'user-only-child',
    });
    const userOnlyParent = track(
      await userOnlyParentCoordinator.acquireUserStateReadLease({
        policy: POLICY,
      }),
    );
    await expect(
      userOnlyChildCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: otherProject },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });
    release(userOnlyParent);

    const missingParentPid = parentPid + 99;
    const missingParentView = syntheticCoordinator({
      pid: childPid,
      parentPid: missingParentPid,
      processIdentities: new Map([
        ...identities,
        [missingParentPid, 'unregistered-parent-incarnation'],
      ]),
      tokenPrefix: 'child-missing-parent',
    });
    const topLevel = track(
      await missingParentView.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    );
    const proofPaths = resolveCoordinationPaths();
    const readSequence = (ownerToken: string) =>
      (
        JSON.parse(
          readFileSync(
            join(
              proofPaths.forProject(parent.coordinationKey!).readersDir,
              `reader-${ownerToken}.json`,
            ),
            'utf8',
          ),
        ) as { sequence: number }
      ).sequence;
    expect(readSequence(topLevel.ownerToken)).toBeGreaterThan(readSequence(parent.ownerToken));
    release(topLevel);

    await expect(
      childCoordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        inheritFromParent: true,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.PARENT_INHERITANCE_DENIED',
    });

    const staleView = syntheticCoordinator({
      pid: childPid,
      parentPid,
      processIdentities: new Map([
        [parentPid, 'reused-parent-incarnation'],
        [childPid, 'child-proof-incarnation'],
      ]),
      tokenPrefix: 'child-stale-parent',
    });
    const reparented = track(
      await staleView.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        inheritFromParent: true,
        policy: POLICY,
      }),
    );
    release(reparented);

    release(parent);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'inherits through the default OS parent identity and keeps a later writer blocked',
    async () => {
      const parent = track(
        await acquireRuntimeAccessLease({
          projectRead: { projectDir: project },
          userStateRead: true,
          policy: { ...POLICY, waitMs: 15_000 },
        }),
      );
      const writerEvents: string[] = [];
      const writerPromise = acquireGlobalRuntimeMaintenanceLease({
        policy: { ...POLICY, waitMs: 30_000 },
        onEvent: (event) => writerEvents.push(event.kind),
      });
      void writerPromise.catch(() => undefined);
      await waitUntil(() => writerEvents.includes('lease.acquire.wait'));

      const worker = String.raw`
        import { pathToFileURL } from "node:url";
        const core = await import(pathToFileURL(process.argv[1]).href);
        try {
          const lease = await core.acquireRuntimeAccessLease({
            projectRead: { projectDir: process.argv[2] },
            userStateRead: true,
            inheritFromParent: true,
            policy: { waitMs: 15000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
          });
          process.stdout.write("READY\n");
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (command) => {
            if (command.trim() !== "RELEASE") process.exit(2);
            lease.release();
            process.stdout.write("DONE\n");
            process.exit(0);
          });
        } catch (error) {
          console.error(error);
          process.exit(3);
        }
      `;
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        worker,
        coreEntryPath(),
        project,
      ]);
      try {
        await waitForChildOutput(child, 'READY\n', 30_000);
        release(parent);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(writerEvents).not.toContain('lease.acquire.complete');

        const completed = waitForChildOutput(child, 'DONE\n', 30_000);
        child.stdin.write('RELEASE\n');
        await completed;
        const writer = track(await writerPromise);
        expect(writerEvents).toContain('lease.acquire.complete');
        release(writer);
      } finally {
        await stopChild(child);
      }
    },
    45_000,
  );

  it('lets a held project writer add reentrant user-state refs ahead of a later global writer', async () => {
    const projectWriter = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'project-writer-user-reentry-0001',
        policy: POLICY,
      }),
    );
    const controller = new AbortController();
    let globalAcquired = false;
    let globalLease: RuntimeLease | undefined;
    const globalPromise = acquireGlobalRuntimeMaintenanceLease({
      policy: { ...POLICY, waitMs: 30_000 },
      signal: controller.signal,
    }).then((lease) => {
      globalAcquired = true;
      globalLease = lease;
      return lease;
    });
    void globalPromise.catch(() => undefined);
    try {
      await waitUntil(async () => {
        const state = await inspectRuntimeLeaseState(project);
        return state.status === 'stable' && state.globalWriter === 'queued';
      }, 15_000);

      const firstUser = track(
        await acquireUserStateReadLease({
          ownerToken: projectWriter.ownerToken,
          policy: POLICY,
        }),
      );
      const secondUser = track(
        await acquireUserStateReadLease({
          ownerToken: projectWriter.ownerToken,
          policy: POLICY,
        }),
      );
      expect(await inspectRuntimeLeaseState(project)).toMatchObject({
        status: 'stable',
        userStateReaders: 1,
      });

      release(projectWriter);
      await waitUntil(async () => {
        const state = await inspectRuntimeLeaseState(project);
        return state.status === 'stable' && state.globalWriter === 'intent';
      }, 15_000);
      release(firstUser);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(globalAcquired).toBe(false);
      release(secondUser);
      const globalWriter = track(await globalPromise);
      expect(globalAcquired).toBe(true);
      release(globalWriter);
      globalLease = undefined;
    } finally {
      controller.abort();
      await globalPromise.catch(() => undefined);
      globalLease?.release();
    }
  }, 30_000);

  it('keeps every exclusive nesting form except project-writer to user-read forbidden', async () => {
    const projectWriter = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'project-writer-nesting-0001',
        policy: POLICY,
      }),
    );
    await expect(
      acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: projectWriter.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE' });
    await expect(
      acquireRuntimeReadLease({
        projectDir: otherProject,
        ownerToken: projectWriter.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE' });

    const mismatchedCoordinator = createRuntimeLeaseCoordinator({
      hostname,
      pid: process.pid + 10_000,
      isProcessAlive: () => true,
      generateToken: () => 'mismatched-process-mutex-0001',
      poll: () => Promise.resolve(),
      pollSync: () => undefined,
    });
    await expect(
      mismatchedCoordinator.acquireUserStateReadLease({
        ownerToken: projectWriter.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH' });
    release(projectWriter);

    const globalWriter = track(
      await acquireGlobalRuntimeMaintenanceLease({
        ownerToken: 'global-writer-nesting-0001',
        policy: POLICY,
      }),
    );
    await expect(
      acquireUserStateReadLease({
        ownerToken: globalWriter.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE' });
    release(globalWriter);
  });

  it('cancels project-writer user reentry without publishing a user reader', async () => {
    const projectReader = track(
      await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    );
    const ownerToken = 'cancelled-user-reentry-writer-0001';
    const writerPromise = acquireRuntimeExclusiveLease({
      projectDir: project,
      ownerToken,
      policy: { ...POLICY, waitMs: 15_000 },
    });
    void writerPromise.catch(() => undefined);
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'intent';
    });
    const controller = new AbortController();
    const events: string[] = [];
    const userPromise = acquireUserStateReadLease({
      ownerToken,
      policy: POLICY,
      signal: controller.signal,
      onEvent: (event) => events.push(event.kind),
    });
    await waitUntil(() => events.includes('lease.acquire.wait'));
    controller.abort();

    await expect(userPromise).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.CANCELLED',
    });
    expect(readdirSync(resolveCoordinationPaths().userReadersDir)).toEqual([]);
    release(projectReader);
    const projectWriter = track(await writerPromise);
    release(projectWriter);
  }, 30_000);

  it('keeps filesystem refcounts across reentrant handles and makes release idempotent', async () => {
    const first = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const second = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: first.ownerToken,
        policy: POLICY,
      }),
    );

    release(first);
    first.release();
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 1,
    });
    release(second);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
    });
  });

  it('makes a partial composite release retry-safe across both dimensions', async () => {
    const policy = { ...POLICY, heartbeatMs: 1000, staleMs: 5000 };
    const projectLease = track(await acquireRuntimeReadLease({ projectDir: project, policy }));
    const composite = track(
      await acquireRuntimeAccessLease({
        ownerToken: projectLease.ownerToken,
        projectRead: { projectDir: project },
        userStateRead: true,
        policy,
      }),
    );
    const paths = resolveCoordinationPaths();
    const projectReaderPath = join(
      paths.forProject(projectCoordinationKey(project)).readersDir,
      `reader-${projectLease.ownerToken}.json`,
    );
    const userReaderPath = join(paths.userReadersDir, `reader-${projectLease.ownerToken}.json`);
    const originalUser = readFileSync(userReaderPath, 'utf8');

    privateWrite(userReaderPath, {});
    expect(() => composite.release()).toThrow(
      expect.objectContaining({
        code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
      }),
    );
    expect(JSON.parse(readFileSync(projectReaderPath, 'utf8'))).toMatchObject({
      refs: 1,
    });

    expect(() => composite.release()).toThrow(
      expect.objectContaining({
        code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
      }),
    );
    expect(JSON.parse(readFileSync(projectReaderPath, 'utf8'))).toMatchObject({
      refs: 1,
    });

    privateWrite(userReaderPath, JSON.parse(originalUser));
    release(composite);
    expect(existsSync(userReaderPath)).toBe(false);
    expect(JSON.parse(readFileSync(projectReaderPath, 'utf8'))).toMatchObject({
      refs: 1,
    });
    release(projectLease);
    expect(existsSync(projectReaderPath)).toBe(false);
  });

  it('cleans an exact composite publication when mutex postconditions fail', async () => {
    let injected = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name !== 'before-mutex-postcondition' || injected) return;
        const paths = resolveCoordinationPaths();
        const key = projectCoordinationKey(project);
        const projectEntries = existsSync(paths.forProject(key).readersDir)
          ? readdirSync(paths.forProject(key).readersDir)
          : [];
        if (projectEntries.length === 0 || readdirSync(paths.userReadersDir).length === 0) return;
        injected = true;
        throw new Error('injected shared publication postcondition failure');
      },
    });

    await expect(
      coordinator.acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: POLICY,
      }),
    ).rejects.toThrow('injected shared publication postcondition failure');

    expect(injected).toBe(true);
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return (
        state.status === 'stable' && state.projectReaders === 0 && state.userStateReaders === 0
      );
    });
  });

  it('undoes only the failed reentrant reference after publication failure', async () => {
    const existing = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    let injected = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name !== 'before-mutex-postcondition' || injected) return;
        const readerPath = join(
          resolveCoordinationPaths().forProject(existing.coordinationKey).readersDir,
          `reader-${existing.ownerToken}.json`,
        );
        if (!existsSync(readerPath)) return;
        const record = JSON.parse(readFileSync(readerPath, 'utf8')) as {
          refs?: number;
        };
        if (record.refs !== 2) return;
        injected = true;
        throw new Error('injected refcount publication postcondition failure');
      },
    });

    await expect(
      coordinator.acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: existing.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toThrow('injected refcount publication postcondition failure');

    const readerPath = join(
      resolveCoordinationPaths().forProject(existing.coordinationKey).readersDir,
      `reader-${existing.ownerToken}.json`,
    );
    await waitUntil(() => {
      const record = JSON.parse(readFileSync(readerPath, 'utf8')) as {
        refs?: number;
      };
      return record.refs === 1;
    });
    release(existing);
  });

  it('refuses reader 129 without poisoning the bounded reader directory', async () => {
    await createScaffold();
    const readersDir = resolveCoordinationPaths().forProject(
      projectCoordinationKey(project),
    ).readersDir;
    for (let index = 1; index <= 128; index += 1) {
      const ownerToken = `capacity-reader-${index.toString().padStart(4, '0')}`;
      privateWrite(
        join(readersDir, `reader-${ownerToken}.json`),
        readerFixture('project', ownerToken, index),
      );
    }

    await expect(
      acquireRuntimeReadLease({
        projectDir: project,
        policy: { ...POLICY, waitMs: 0, staleMs: 60_000 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });
    expect(readdirSync(readersDir).filter((entry) => entry.startsWith('reader-'))).toHaveLength(
      128,
    );
  });

  it('refuses reference 65 without publishing an invalid owner record', async () => {
    const policy = { ...POLICY, waitMs: 0, staleMs: 60_000 };
    const lease = track(await acquireRuntimeReadLease({ projectDir: project, policy }));
    const readersDir = resolveCoordinationPaths().forProject(
      projectCoordinationKey(project),
    ).readersDir;
    const recordPath = join(readersDir, `reader-${lease.ownerToken}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      refs: number;
      references: string[];
    } & Record<string, unknown>;
    const references = [
      record.references[0],
      ...Array.from({ length: 63 }, (_, index) => (index + 1000).toString(16).padStart(24, '0')),
    ];
    privateWrite(recordPath, { ...record, refs: 64, references });

    await expect(
      acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: lease.ownerToken,
        policy,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toMatchObject({
      refs: 64,
      references,
    });

    release(lease);
    rmSync(recordPath, { force: true });
  });

  it('refuses project key 257 when every bounded key contains recovery state', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const existing = new Set(readdirSync(paths.projectsDir));
    const candidateKeys = Array.from({ length: 257 }, (_, index) =>
      (index + 1).toString(16).padStart(24, '0'),
    );
    for (const coordinationKey of candidateKeys) {
      if (existing.size >= 256) break;
      if (existing.has(coordinationKey)) continue;
      const projectDirPath = paths.forProject(coordinationKey).projectCoordinationDir;
      mkdirSync(projectDirPath, { mode: 0o700 });
      mkdirSync(join(projectDirPath, 'readers'), { mode: 0o700 });
      if (process.platform !== 'win32') {
        chmodSync(projectDirPath, 0o700);
        chmodSync(join(projectDirPath, 'readers'), 0o700);
      }
      existing.add(coordinationKey);
    }
    for (const coordinationKey of existing) {
      privateWrite(paths.forProject(coordinationKey).promotionJournalFile, {
        kind: 'init-promotion',
        version: 1,
        coordinationKey,
        operationId: `capacity-${coordinationKey}`,
        state: 'closed',
      });
    }
    const nextKey = projectCoordinationKey(otherProject);
    expect(existing.has(nextKey)).toBe(false);

    await expect(
      acquireRuntimeReadLease({
        projectDir: otherProject,
        policy: { ...POLICY, waitMs: 0, staleMs: 60_000 },
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.CAPACITY' });
    expect(existsSync(paths.forProject(nextKey).projectCoordinationDir)).toBe(false);
    expect(readdirSync(paths.projectsDir)).toHaveLength(256);
  });

  it('sweeps a proven-empty scaffold to admit project key 257', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const existing = new Set(readdirSync(paths.projectsDir));
    for (let index = 1; index <= 256 && existing.size < 256; index += 1) {
      const coordinationKey = index.toString(16).padStart(24, '0');
      if (existing.has(coordinationKey)) continue;
      const projectDirPath = paths.forProject(coordinationKey).projectCoordinationDir;
      mkdirSync(projectDirPath, { mode: 0o700 });
      mkdirSync(join(projectDirPath, 'readers'), { mode: 0o700 });
      if (process.platform !== 'win32') {
        chmodSync(projectDirPath, 0o700);
        chmodSync(join(projectDirPath, 'readers'), 0o700);
      }
      existing.add(coordinationKey);
    }
    const nextKey = projectCoordinationKey(otherProject);
    expect(existing.has(nextKey)).toBe(false);

    const reader = track(
      await acquireRuntimeReadLease({
        projectDir: otherProject,
        policy: { ...POLICY, waitMs: 5000 },
      }),
    );
    expect(reader.coordinationKey).toBe(nextKey);
    expect(existsSync(paths.forProject(nextKey).projectCoordinationDir)).toBe(true);
    expect(readdirSync(paths.projectsDir)).toHaveLength(256);
    release(reader);
  });

  it('rejects owner-token project mismatch and exclusive upgrades', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    await expect(
      acquireRuntimeReadLease({
        projectDir: otherProject,
        ownerToken: reader.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH' });
    await expect(
      acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: reader.ownerToken,
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE' });
  });

  it('cleans a cancelled writer request without killing or releasing the reader', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const controller = new AbortController();
    const writer = acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: POLICY,
      signal: controller.signal,
    });
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'intent';
    });
    controller.abort();
    await expect(writer).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.CANCELLED',
    });
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'none';
    });
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 1,
    });
    release(reader);
  });

  it('retries exact writer cleanup after its first mutex section fails', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const controller = new AbortController();
    let injectCleanupFailure = false;
    let injected = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: () => {
        if (!injectCleanupFailure || injected) return;
        injected = true;
        throw new Error('injected cleanup failure');
      },
    });
    const writer = coordinator.acquireRuntimeExclusiveLease({
      projectDir: project,
      policy: { ...POLICY, waitMs: 2000 },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind !== 'lease.acquire.wait') return;
        injectCleanupFailure = true;
        controller.abort();
      },
    });
    void writer.catch(() => undefined);

    await expect(writer).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.CANCELLED',
    });
    expect(injected).toBe(true);
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'none';
    });
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 1,
      writer: 'none',
    });
    release(reader);
  });

  it('cleans a staged writer when mutex postconditions fail after publication', async () => {
    let injected = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name !== 'before-mutex-postcondition' || injected) return;
        const statePath = resolveCoordinationPaths().stateFile;
        if (!existsSync(statePath)) return;
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
          writers?: unknown[];
        };
        if (state.writers?.length !== 1) return;
        injected = true;
        throw new Error('injected writer publication postcondition failure');
      },
    });

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    ).rejects.toThrow('injected writer publication postcondition failure');

    expect(injected).toBe(true);
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.writer === 'none';
    });
  });

  it('coalesces deferred publication cleanup behind one bounded scheduler', async () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    let allowCleanupPostcondition = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name === 'before-mutex-postcondition' && !allowCleanupPostcondition) {
          throw new Error('injected persistent postcondition failure');
        }
      },
    });

    try {
      for (let index = 0; index < 8; index += 1) {
        await expect(
          coordinator.acquireRuntimeReadLease({
            projectDir: project,
            policy: POLICY,
          }),
        ).rejects.toThrow('injected persistent postcondition failure');
      }

      expect(intervalSpy).toHaveBeenCalledTimes(1);
      allowCleanupPostcondition = true;
      await waitUntil(() => clearIntervalSpy.mock.calls.length === 1);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      allowCleanupPostcondition = true;
      if (intervalSpy.mock.calls.length > clearIntervalSpy.mock.calls.length) {
        await waitUntil(
          () => clearIntervalSpy.mock.calls.length >= intervalSpy.mock.calls.length,
        ).catch(() => undefined);
      }
      intervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('makes global maintenance exclude user and every project dimension', async () => {
    const projectReader = track(
      await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    );
    const userReader = track(await acquireUserStateReadLease({ policy: POLICY }));
    const globalPromise = acquireGlobalRuntimeMaintenanceLease({
      policy: POLICY,
    });
    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return state.status === 'stable' && state.globalWriter === 'intent';
    });

    await expect(
      acquireRuntimeReadLease({
        projectDir: otherProject,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });
    release(userReader);
    release(projectReader);
    track(await globalPromise);
  });

  it('returns stable wait-kind timeout codes for composite, user, and global contention', async () => {
    const global = track(
      await acquireGlobalRuntimeMaintenanceLease({
        policy: POLICY,
      }),
    );
    await expect(acquireUserStateReadLease({ policy: SHORT_POLICY })).rejects.toMatchObject({
      code: 'TIMEOUT.USER_STATE_READ',
    });
    await expect(
      acquireRuntimeAccessLease({
        projectRead: { projectDir: project },
        userStateRead: true,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT.RUNTIME_ACCESS_COMPOSITE',
    });
    release(global);

    const user = track(await acquireUserStateReadLease({ policy: POLICY }));
    await expect(
      acquireGlobalRuntimeMaintenanceLease({
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT.RUNTIME_GLOBAL_MAINTENANCE',
    });
    release(user);
  });

  it('rejects writers explicitly at the bounded queue cap', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const queued = controllers.map((controller, index) =>
      acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: `${index}${'a'.repeat(126)}`,
        command: '🧠'.repeat(9),
        cwdBasename: '界'.repeat(12),
        policy: { ...POLICY, waitMs: 60_000 },
        signal: controller.signal,
      }),
    );
    for (const request of queued) void request.catch(() => undefined);
    try {
      const statePath = resolveCoordinationPaths().stateFile;
      await waitUntil(() => {
        const raw = readFileSync(statePath, 'utf8');
        const state = JSON.parse(raw) as {
          writers: unknown[];
        };
        expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(4096);
        return state.writers.length === 8;
      }, 30_000);

      await expect(
        acquireRuntimeExclusiveLease({
          projectDir: project,
          command: 'rejected-ninth',
          policy: { ...POLICY, waitMs: 10_000 },
        }),
      ).rejects.toMatchObject({
        code: 'SYSTEM.RUNTIME_LEASE.CAPACITY',
      });
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        writers: { command: string }[];
      };
      expect(state.writers).toHaveLength(8);
      expect(state.writers.some((writer) => writer.command === 'rejected-ninth')).toBe(false);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(queued);
      release(reader);
    }
  }, 45_000);

  it('uses the stable capacity error while the queue stays full', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const queued = controllers.map((controller, index) =>
      acquireRuntimeExclusiveLease({
        projectDir: project,
        command: `full-${index}`,
        policy: { ...POLICY, waitMs: 60_000 },
        signal: controller.signal,
      }),
    );
    for (const request of queued) void request.catch(() => undefined);
    try {
      const statePath = resolveCoordinationPaths().stateFile;
      await waitUntil(() => {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
          writers: unknown[];
        };
        return state.writers.length === 8;
      }, 30_000);

      await expect(
        acquireRuntimeExclusiveLease({
          projectDir: project,
          policy: SHORT_POLICY,
        }),
      ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.CAPACITY' });
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(queued);
      release(reader);
    }
  }, 45_000);

  it('bounds cached and destructive process probes during one global reader scan', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const instance = 'process-probe-boot';
    const localHost = hostId('process-probe-host', instance);
    const keys = [
      '100000000000000000000001',
      '100000000000000000000002',
      '100000000000000000000003',
    ];
    let sequence = 1;
    for (const key of keys) {
      const projectPaths = paths.forProject(key);
      mkdirSync(projectPaths.projectCoordinationDir, {
        recursive: true,
        mode: 0o700,
      });
      mkdirSync(projectPaths.readersDir, { mode: 0o700 });
      if (process.platform !== 'win32') {
        chmodSync(projectPaths.projectCoordinationDir, 0o700);
        chmodSync(projectPaths.readersDir, 0o700);
      }
      for (let index = 0; index < 128; index += 1) {
        const pid = 100_001;
        const ownerToken = `probe-owner-${sequence.toString().padStart(8, '0')}`;
        privateWrite(join(projectPaths.readersDir, `reader-${ownerToken}.json`), {
          ...readerFixture('project', ownerToken, sequence),
          pid,
          hostname: localHost,
          hostIdentityProven: true,
          processIncarnation: 'inc-before-pid-reuse',
        });
        sequence += 1;
      }
    }
    let inspectedOwners = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      hostname: () => 'process-probe-host',
      hostInstanceIdentity: () => instance,
      inspectProcessIncarnation: (pid) => {
        if (pid !== process.pid) inspectedOwners += 1;
        return { status: 'present', identity: `inc-current-${pid}` } as const;
      },
    });

    await expect(
      coordinator.acquireGlobalRuntimeMaintenanceLease({
        policy: { waitMs: 0, staleMs: 60_000, heartbeatMs: 10, pollMs: 1 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_GLOBAL_MAINTENANCE' });

    expect(inspectedOwners).toBeGreaterThan(0);
    expect(inspectedOwners).toBeLessThanOrEqual(256);
  }, 15_000);

  it('serializes shared heartbeats while the coordination mutex is contended', async () => {
    let activePolls = 0;
    let maxActivePolls = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      poll: async (ms) => {
        activePolls += 1;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(200, ms)));
        activePolls -= 1;
      },
    });
    const lease = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: { waitMs: 1000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
      }),
    );
    const mutex = resolveCoordinationPaths().globalMutexFile;
    const now = Date.now();
    privateWrite(mutex, {
      ownerToken: 'remote-heartbeat-mutex-0001',
      pid: 999_991,
      hostname: hostId('remote-heartbeat-host'),
      hostIdentityProven: false,
      acquiredAt: now,
      lastHeartbeatAt: now,
      staleMs: 5000,
    });

    await waitUntil(() => activePolls > 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(maxActivePolls).toBe(1);

    rmSync(mutex);
    await waitUntil(() => activePolls === 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    release(lease);
  });

  it('serializes writer heartbeats while the coordination mutex is contended', async () => {
    let activePolls = 0;
    let maxActivePolls = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      poll: async (ms) => {
        activePolls += 1;
        maxActivePolls = Math.max(maxActivePolls, activePolls);
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(200, ms)));
        activePolls -= 1;
      },
    });
    const lease = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: { waitMs: 1000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
      }),
    );
    const mutex = resolveCoordinationPaths().globalMutexFile;
    const now = Date.now();
    privateWrite(mutex, {
      ownerToken: 'remote-writer-heartbeat-0001',
      pid: 999_992,
      hostname: hostId('remote-writer-heartbeat-host'),
      hostIdentityProven: false,
      acquiredAt: now,
      lastHeartbeatAt: now,
      staleMs: 5000,
    });

    await waitUntil(() => activePolls > 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(maxActivePolls).toBe(1);

    rmSync(mutex);
    await waitUntil(() => activePolls === 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    release(lease);
  });

  it('uses an isolated deterministic coordinator for clock, polling, and transition tests', async () => {
    let now = 1000;
    const transitions: string[] = [];
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => now,
      hostname,
      pid: process.pid,
      isProcessAlive: () => true,
      generateToken: () => 'deterministic-owner-0001',
      poll: async (ms) => {
        now += ms;
        await Promise.resolve();
      },
      pollSync: (ms) => {
        now += ms;
      },
      transition: (name) => transitions.push(name),
    });
    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: 'deterministic-reader-0001',
        policy: { waitMs: 10, staleMs: 50, heartbeatMs: 1000, pollMs: 3 },
      }),
    );

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'deterministic-writer-0001',
        policy: { waitMs: 10, staleMs: 50, heartbeatMs: 1000, pollMs: 3 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });

    expect(now).toBe(1010);
    expect(transitions).toContain('lease.acquire.wait');
    const state = JSON.parse(readFileSync(resolveCoordinationPaths().stateFile, 'utf8')) as {
      writers: unknown[];
    };
    expect(state.writers).toEqual([]);
    release(reader);
  });

  it('firewalls diagnostic observers before and after lease publication', async () => {
    const coordinator = createRuntimeLeaseCoordinator({
      transition: () => {
        throw new Error('transition observer failed');
      },
    });
    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
        onEvent: () => {
          throw new Error('event observer failed');
        },
      }),
    );
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 1,
    });
    release(reader);

    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
        onEvent: () => {
          throw new Error('event observer failed');
        },
      }),
    );
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      writer: 'intent',
    });
    release(writer);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
      writer: 'none',
    });
  });

  it('keeps coordination paths and owner tokens out of emitted events', async () => {
    const events: unknown[] = [];
    const lease = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: 'redacted-event-owner-0001',
        policy: POLICY,
        onEvent: (event) => events.push(event),
      }),
    );
    release(lease);

    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain(home);
    expect(rendered).not.toContain(project);
    expect(rendered).not.toContain('redacted-event-owner-0001');
    expect(rendered).not.toContain(resolveCoordinationPaths().globalMutexFile);
  });

  it('uses the bounded persisted hostname consistently for ownership', async () => {
    let currentHostname = 'long-hostname-'.repeat(12);
    const coordinator = createRuntimeLeaseCoordinator({
      hostname: () => currentHostname,
    });
    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    currentHostname = 'changed-after-acquire';
    release(reader);
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    release(writer);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
      writer: 'none',
    });
  });

  it('recovers a reader create that crashed before hard-link publication', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const readersDir = paths.forProject(projectCoordinationKey(project)).readersDir;
    const target = join(readersDir, 'reader-orphaned-prelink-owner-0001.json');
    const temporary = join(
      readersDir,
      '.reader-orphaned-prelink-owner-0001.json.tmp-12345678-1234-4234-8234-123456789012',
    );
    privateWrite(temporary, { incomplete: true });
    expect(existsSync(target)).toBe(false);

    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(target)).toBe(false);
    release(writer);
  });

  it('reconciles proven orphan transition temps under the next mutex owner', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const projectPaths = paths.forProject(projectCoordinationKey(project));
    const stateTemp = join(
      paths.coordinationDir,
      '.state.json.tmp-12345678-1234-4234-8234-123456789012',
    );
    const promotionTemp = join(
      projectPaths.projectCoordinationDir,
      '.runtime-promotion.json.tmp-12345678-1234-4234-8234-123456789013',
    );
    const mutexTemp = join(
      paths.coordinationDir,
      '.coordination.lock.tmp-12345678-1234-4234-8234-123456789014',
    );
    privateWrite(stateTemp, { version: 1, abandoned: true });
    privateWrite(promotionTemp, { version: 1, abandoned: true });
    privateWrite(mutexTemp, {
      ownerToken: 'orphaned-mutex-owner-0001',
      pid: 999_999_999,
      hostname: hostId(hostname()),
      hostIdentityProven: false,
      acquiredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      staleMs: 60_000,
    });

    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    expect(existsSync(stateTemp)).toBe(false);
    expect(existsSync(promotionTemp)).toBe(false);
    expect(existsSync(mutexTemp)).toBe(false);
    release(reader);
  });

  it('reclaims a fresh same-host reader only when its owner process is dead', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const readersDir = paths.forProject(projectCoordinationKey(project)).readersDir;
    const hostInstance = 'deterministic-host-instance';
    privateWrite(join(readersDir, 'reader-stale-same-host-0001.json'), {
      version: 1,
      dimension: 'project',
      refs: 1,
      references: ['000000000000000000000001'],
      ownerToken: 'stale-same-host-0001',
      pid: 424_242,
      hostname: hostId('deterministic-host', hostInstance),
      hostIdentityProven: true,
      command: 'stale-test',
      cwdBasename: 'project',
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
      sequence: 1,
    });
    const staleEvents: string[] = [];
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => 5000,
      hostname: () => 'deterministic-host',
      hostInstanceIdentity: () => hostInstance,
      pid: process.pid,
      isProcessAlive: (pid) => pid !== 424_242,
      generateToken: () => 'deterministic-writer-0002',
      poll: () => Promise.resolve(),
    });

    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
        onEvent: (event) => staleEvents.push(event.kind),
      }),
    );

    expect(staleEvents).toContain('lease.stale.recovered');
    expect(existsSync(join(readersDir, 'reader-stale-same-host-0001.json'))).toBe(false);
    release(writer);
  });

  it('reclaims a same-host reader after proven PID reuse', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const readersDir = paths.forProject(projectCoordinationKey(project)).readersDir;
    const hostInstance = 'pid-reuse-host-instance';
    const readerPath = join(readersDir, 'reader-pid-reuse-owner-0001.json');
    privateWrite(readerPath, {
      version: 1,
      dimension: 'project',
      refs: 1,
      references: ['000000000000000000000001'],
      ownerToken: 'pid-reuse-owner-0001',
      pid: 424_242,
      hostname: hostId('pid-reuse-host', hostInstance),
      hostIdentityProven: true,
      processIncarnation: 'process-incarnation-old',
      command: 'stale-test',
      cwdBasename: 'project',
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
      sequence: 1,
    });
    const coordinator = createRuntimeLeaseCoordinator({
      hostname: () => 'pid-reuse-host',
      hostInstanceIdentity: () => hostInstance,
      isProcessAlive: () => true,
      inspectProcessIncarnation: (pid) =>
        pid === 424_242
          ? { status: 'present', identity: 'process-incarnation-new' }
          : { status: 'present', identity: 'current-process-incarnation' },
    });

    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );

    expect(existsSync(readerPath)).toBe(false);
    release(writer);
  });

  it('preserves a reader heartbeat that wins the stale-unlink CAS race', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const readersDir = paths.forProject(projectCoordinationKey(project)).readersDir;
    const hostInstance = 'stale-cas-host-instance';
    const readerPath = join(readersDir, 'reader-stale-cas-owner-0001.json');
    const stale = {
      version: 1,
      dimension: 'project',
      refs: 1,
      references: ['000000000000000000000001'],
      ownerToken: 'stale-cas-owner-0001',
      pid: 424_242,
      hostname: hostId('stale-cas-host', hostInstance),
      hostIdentityProven: true,
      processIncarnation: 'process-incarnation-old',
      command: 'stale-test',
      cwdBasename: 'project',
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
      sequence: 1,
    };
    privateWrite(readerPath, stale);
    let publishedSuccessor = false;
    const successor = {
      ...stale,
      pid: process.pid,
      processIncarnation: 'process-incarnation-current',
      lastHeartbeatAt: 6000,
    };
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => 6000,
      monotonicNow: () => monotonic,
      hostname: () => 'stale-cas-host',
      hostInstanceIdentity: () => hostInstance,
      isProcessAlive: (pid) => pid === process.pid,
      inspectProcessIncarnation: (pid) =>
        pid === process.pid
          ? { status: 'present', identity: 'process-incarnation-current' }
          : { status: 'present', identity: 'process-incarnation-new' },
      coordinationCheckpoint: (name) => {
        if (name !== 'before-stale-reader-unlink' || publishedSuccessor) return;
        publishedSuccessor = true;
        privateWrite(readerPath, successor);
      },
      poll: async (ms) => {
        monotonic += ms;
        await Promise.resolve();
      },
    });

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: { ...SHORT_POLICY, pollMs: 10 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });

    expect(publishedSuccessor).toBe(true);
    expect(JSON.parse(readFileSync(readerPath, 'utf8'))).toEqual(successor);
  });

  it('reclaims a same-host queued writer after proven PID reuse', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const hostInstance = 'writer-pid-reuse-host-instance';
    privateWrite(paths.stateFile, {
      version: 1,
      nextSequence: 2,
      writers: [
        {
          ownerToken: 'writer-pid-reuse-owner-0001',
          pid: 424_242,
          hostname: hostId('writer-pid-reuse-host', hostInstance),
          hostIdentityProven: true,
          processIncarnation: 'process-incarnation-old',
          command: 'stale-writer',
          cwdBasename: 'project',
          acquiredAt: 5000,
          lastHeartbeatAt: 5000,
          staleMs: 120,
          sequence: 1,
          kind: 'project',
          coordinationKey: projectCoordinationKey(project),
          phase: 'queued',
        },
      ],
    });
    const coordinator = createRuntimeLeaseCoordinator({
      hostname: () => 'writer-pid-reuse-host',
      hostInstanceIdentity: () => hostInstance,
      isProcessAlive: () => true,
      inspectProcessIncarnation: (pid) =>
        pid === 424_242
          ? { status: 'present', identity: 'process-incarnation-new' }
          : { status: 'present', identity: 'current-process-incarnation' },
    });

    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );

    const state = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as {
      writers: unknown[];
    };
    expect(state.writers).toEqual([]);
    release(reader);
  });

  it('reclaims a same-host mutex after proven PID reuse', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const hostInstance = 'mutex-pid-reuse-host-instance';
    privateWrite(paths.globalMutexFile, {
      ownerToken: 'mutex-pid-reuse-owner-0001',
      pid: 424_242,
      hostname: hostId('mutex-pid-reuse-host', hostInstance),
      hostIdentityProven: true,
      processIncarnation: 'process-incarnation-old',
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
    });
    const coordinator = createRuntimeLeaseCoordinator({
      hostname: () => 'mutex-pid-reuse-host',
      hostInstanceIdentity: () => hostInstance,
      isProcessAlive: () => true,
      inspectProcessIncarnation: (pid) =>
        pid === 424_242
          ? { status: 'present', identity: 'process-incarnation-new' }
          : { status: 'present', identity: 'current-process-incarnation' },
    });

    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );

    expect(existsSync(paths.globalMutexFile)).toBe(false);
    release(reader);
  });

  it('caches live mutex process proofs across bounded acquisition polling', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const hostInstance = 'mutex-live-probe-host-instance';
    privateWrite(paths.globalMutexFile, {
      ownerToken: 'mutex-live-probe-owner-0001',
      pid: 424_242,
      hostname: hostId('mutex-live-probe-host', hostInstance),
      hostIdentityProven: true,
      processIncarnation: 'mutex-live-process-incarnation',
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
    });
    let monotonic = 0;
    let incumbentInspections = 0;
    let contenderInspections = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => 5000,
      monotonicNow: () => monotonic,
      hostname: () => 'mutex-live-probe-host',
      hostInstanceIdentity: () => hostInstance,
      inspectProcessIncarnation: (pid) => {
        if (pid === 424_242) {
          incumbentInspections += 1;
          return {
            status: 'present',
            identity: 'mutex-live-process-incarnation',
          } as const;
        }
        contenderInspections += 1;
        return {
          status: 'present',
          identity: 'contender-process-incarnation',
        } as const;
      },
      poll: async (ms) => {
        monotonic += ms;
        await Promise.resolve();
      },
    });

    await expect(
      coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: { waitMs: 100, staleMs: 120, heartbeatMs: 30, pollMs: 2 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });

    expect(incumbentInspections).toBe(1);
    expect(contenderInspections).toBe(1);
    expect(existsSync(paths.globalMutexFile)).toBe(true);
  });

  it('automatically reclaims an unchanged expired cross-host reader', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const readersDir = paths.forProject(projectCoordinationKey(project)).readersDir;
    privateWrite(join(readersDir, 'reader-stale-remote-host-0001.json'), {
      version: 1,
      dimension: 'project',
      refs: 1,
      references: ['000000000000000000000002'],
      ownerToken: 'stale-remote-host-0001',
      pid: 424_242,
      hostname: hostId('remote-host'),
      hostIdentityProven: false,
      command: 'stale-test',
      cwdBasename: 'project',
      acquiredAt: 5000,
      lastHeartbeatAt: 4995,
      staleMs: 50,
      sequence: 1,
    });
    let now = 5000;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => now,
      hostname: () => 'local-host',
      pid: process.pid,
      isProcessAlive: (pid) => pid === process.pid,
      generateToken: () => 'deterministic-writer-0003',
      poll: async (ms) => {
        now += ms;
        await Promise.resolve();
      },
    });
    const policy = { waitMs: 10, staleMs: 50, heartbeatMs: 10, pollMs: 2 };

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(join(readersDir, 'reader-stale-remote-host-0001.json'))).toBe(true);

    now = 5100;
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'deterministic-writer-0004',
        policy: { ...policy, waitMs: 100 },
      }),
    );
    expect(existsSync(join(readersDir, 'reader-stale-remote-host-0001.json'))).toBe(false);
    release(writer);
  });

  it('recovers unrelated expired foreign writer records during a bounded scan', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const projectKey = projectCoordinationKey(project);
    const otherKey = projectCoordinationKey(otherProject);
    const otherPaths = paths.forProject(otherKey);
    mkdirSync(otherPaths.projectCoordinationDir, { mode: 0o700 });
    mkdirSync(otherPaths.readersDir, { mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(otherPaths.projectCoordinationDir, 0o700);
      chmodSync(otherPaths.readersDir, 0o700);
    }
    privateWrite(paths.stateFile, {
      version: 1,
      nextSequence: 2,
      writers: [
        {
          ownerToken: 'unrelated-foreign-writer-0001',
          pid: 424_242,
          hostname: hostId('unrelated-foreign-host'),
          hostIdentityProven: false,
          command: 'remote-maintenance',
          cwdBasename: 'other-project',
          acquiredAt: 5000,
          lastHeartbeatAt: 5000,
          staleMs: 30,
          sequence: 1,
          kind: 'project',
          coordinationKey: otherKey,
          phase: 'queued',
        },
      ],
    });
    const readersDir = paths.forProject(projectKey).readersDir;
    const blockingReader = join(readersDir, 'reader-project-recovery-blocker-0001.json');
    privateWrite(blockingReader, {
      ...readerFixture('project', 'project-recovery-blocker-0001', 1),
      hostname: hostId('project-recovery-foreign-host'),
      staleMs: 30,
    });
    let wallNow = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'project-recovery-local-host',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'scoped-recovery-writer-0001',
        policy: { waitMs: 100, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    );

    expect(existsSync(blockingReader)).toBe(false);
    release(writer);
    const persisted = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as {
      writers: { ownerToken: string }[];
    };
    expect(persisted.writers.map(({ ownerToken }) => ownerToken)).not.toContain(
      'unrelated-foreign-writer-0001',
    );
  });

  it('lets an ordinary reader reclaim an unchanged expired foreign writer', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    privateWrite(paths.stateFile, {
      version: 1,
      nextSequence: 2,
      writers: [
        {
          ownerToken: 'foreign-reader-blocker-0001',
          pid: 424_242,
          hostname: hostId('foreign-reader-blocker-host'),
          hostIdentityProven: false,
          command: 'remote-maintenance',
          cwdBasename: 'project',
          acquiredAt: 5000,
          lastHeartbeatAt: 5000,
          staleMs: 30,
          sequence: 1,
          kind: 'project',
          coordinationKey: projectCoordinationKey(project),
          phase: 'intent',
        },
      ],
    });
    let wallNow = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'foreign-reader-local-host',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: { waitMs: 100, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    );

    const persisted = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as {
      writers: { ownerToken: string }[];
    };
    expect(persisted.writers).toEqual([]);
    release(reader);
  });

  it('honors the owner stale horizon when a contender requests a shorter policy', async () => {
    await createScaffold();
    const readersDir = resolveCoordinationPaths().forProject(
      projectCoordinationKey(project),
    ).readersDir;
    const remotePath = join(readersDir, 'reader-mixed-policy-owner-0001.json');
    privateWrite(remotePath, {
      ...readerFixture('project', 'mixed-policy-owner-0001', 1),
      hostname: hostId('mixed-policy-remote'),
      staleMs: 120,
    });
    let now = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => now,
      monotonicNow: () => monotonic,
      hostname: () => 'mixed-policy-local',
      poll: async (ms) => {
        now += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });
    const contenderPolicy = {
      waitMs: 50,
      staleMs: 30,
      heartbeatMs: 10,
      pollMs: 2,
    };

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'mixed-policy-writer-0001',
        policy: contenderPolicy,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(remotePath)).toBe(true);

    const observedFrom = monotonic;
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'mixed-policy-writer-0002',
        policy: { ...contenderPolicy, waitMs: 200 },
      }),
    );
    expect(monotonic - observedFrom).toBeGreaterThan(120);
    expect(existsSync(remotePath)).toBe(false);
    release(writer);
  });

  it('does not reclaim a foreign owner from wall-clock skew alone', async () => {
    await createScaffold();
    const readersDir = resolveCoordinationPaths().forProject(
      projectCoordinationKey(project),
    ).readersDir;
    const remotePath = join(readersDir, 'reader-clock-skew-owner-0001.json');
    privateWrite(remotePath, {
      ...readerFixture('project', 'clock-skew-owner-0001', 1),
      hostname: hostId('clock-skew-remote'),
      acquiredAt: 1000,
      lastHeartbeatAt: 1000,
      staleMs: 120,
    });
    let wallNow = 61_000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'clock-skew-local',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    await expect(
      coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: 'clock-skew-writer-0001',
        policy: { waitMs: 50, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(remotePath)).toBe(true);
  });

  it('hashes long hostnames so shared prefixes cannot collapse owner identity', async () => {
    const sharedPrefix = 'same-prefix-'.repeat(12);
    const first = createRuntimeLeaseCoordinator({
      hostname: () => `${sharedPrefix}first`,
    });
    const second = createRuntimeLeaseCoordinator({
      hostname: () => `${sharedPrefix}second`,
      isProcessAlive: () => false,
    });
    const reader = track(
      await first.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const readerPath = join(
      resolveCoordinationPaths().forProject(reader.coordinationKey).readersDir,
      `reader-${reader.ownerToken}.json`,
    );
    const persisted = JSON.parse(readFileSync(readerPath, 'utf8')) as {
      hostname: string;
    };
    expect(persisted.hostname).toBe(hostId(`${sharedPrefix}first`));
    expect(persisted.hostname).not.toBe(hostId(`${sharedPrefix}second`));

    await expect(
      second.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(readerPath)).toBe(true);
    release(reader);
  });

  it('does not treat equal hostnames from different host instances as local', async () => {
    const first = createRuntimeLeaseCoordinator({
      hostname: () => 'shared-container-hostname',
      hostInstanceIdentity: () => 'host-instance-a',
      pid: 424_242,
    });
    const second = createRuntimeLeaseCoordinator({
      hostname: () => 'shared-container-hostname',
      hostInstanceIdentity: () => 'host-instance-b',
      isProcessAlive: (pid) => pid === process.pid,
    });
    const reader = track(
      await first.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const readerPath = join(
      resolveCoordinationPaths().forProject(reader.coordinationKey).readersDir,
      `reader-${reader.ownerToken}.json`,
    );

    await expect(
      second.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(readerPath)).toBe(true);
    release(reader);
  });

  it('treats one proven host instance as local across hostname changes', async () => {
    const instanceIdentity = 'stable-host-instance';
    const first = createRuntimeLeaseCoordinator({
      hostname: () => 'hostname-before-change',
      hostInstanceIdentity: () => instanceIdentity,
    });
    const second = createRuntimeLeaseCoordinator({
      hostname: () => 'hostname-after-change',
      hostInstanceIdentity: () => instanceIdentity,
    });
    const reader = track(
      await first.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const readerPath = join(
      resolveCoordinationPaths().forProject(reader.coordinationKey).readersDir,
      `reader-${reader.ownerToken}.json`,
    );
    const persisted = JSON.parse(readFileSync(readerPath, 'utf8')) as {
      hostname: string;
    };

    expect(persisted.hostname).toBe(hostId('ignored-hostname', instanceIdentity));
    const nested = track(
      await second.acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: reader.ownerToken,
        policy: POLICY,
      }),
    );
    release(nested);
    release(reader);
  });

  it('does not treat equal unproven hostnames as local PID authority', async () => {
    const first = createRuntimeLeaseCoordinator({
      hostname: () => 'shared-unproven-hostname',
      hostInstanceIdentity: () => undefined,
      pid: 424_242,
    });
    const second = createRuntimeLeaseCoordinator({
      hostname: () => 'shared-unproven-hostname',
      hostInstanceIdentity: () => undefined,
      isProcessAlive: () => false,
    });
    const reader = track(
      await first.acquireRuntimeReadLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const readerPath = join(
      resolveCoordinationPaths().forProject(reader.coordinationKey).readersDir,
      `reader-${reader.ownerToken}.json`,
    );

    await expect(
      second.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: SHORT_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });
    expect(existsSync(readerPath)).toBe(true);
    release(reader);
  });

  it('honors the foreign mutex owner horizon instead of the contender policy', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    privateWrite(paths.globalMutexFile, {
      ownerToken: 'foreign-mutex-owner-0001',
      pid: 424_242,
      hostname: hostId('foreign-mutex-host'),
      hostIdentityProven: false,
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 120,
    });
    let wallNow = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'foreign-mutex-contender',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });
    const contenderPolicy = {
      waitMs: 50,
      staleMs: 30,
      heartbeatMs: 10,
      pollMs: 2,
    };

    await expect(
      coordinator.acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: 'foreign-mutex-reader-0001',
        policy: contenderPolicy,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });
    expect(existsSync(paths.globalMutexFile)).toBe(true);

    const observedFrom = monotonic;
    const reader = track(
      await coordinator.acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: 'foreign-mutex-reader-0002',
        policy: { ...contenderPolicy, waitMs: 200 },
      }),
    );
    expect(monotonic - observedFrom).toBeGreaterThan(120);
    expect(existsSync(paths.globalMutexFile)).toBe(false);
    release(reader);
  });

  it('bounds acquisition by monotonic time during a local wall-clock rollback', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    privateWrite(paths.globalMutexFile, {
      ownerToken: 'rollback-mutex-owner-0001',
      pid: 424_242,
      hostname: hostId('rollback-remote-host'),
      hostIdentityProven: false,
      acquiredAt: 5000,
      lastHeartbeatAt: 5000,
      staleMs: 60_000,
    });
    let wallNow = 10_000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'rollback-local-host',
      poll: async (ms) => {
        wallNow -= 100;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    await expect(
      coordinator.acquireRuntimeReadLease({
        projectDir: project,
        policy: { waitMs: 20, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_READ' });
    expect(monotonic).toBe(20);
    expect(wallNow).toBeLessThan(10_000);
  });

  it('coordinates a barrier-synchronized cold start across processes', async () => {
    const coreEntry = coreEntryPath();
    expect(existsSync(coreEntry)).toBe(true);
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write("READY\n");
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", async (command) => {
        if (command.trim() !== "GO") process.exit(2);
        try {
          const lease = await core.acquireRuntimeReadLease({
            projectDir: process.argv[2],
            policy: { waitMs: 30000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
          });
          lease.release();
          process.stdout.write("DONE\n");
          process.exit(0);
        } catch (error) {
          console.error(error);
          process.exit(3);
        }
      });
    `;

    await runBarrierWorkers(worker, 16, coreEntry, project);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
    });
  });

  it('waits without spinning when synchronous release meets healthy mutex contention', async () => {
    const lease = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        policy: {
          waitMs: 7000,
          staleMs: 20_000,
          heartbeatMs: 1000,
          pollMs: 25,
        },
      }),
    );
    const runtimeLeaseEntry = runtimeLeaseEntryPath();
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      let paused = false;
      const coordinator = core.createRuntimeLeaseCoordinator({
        coordinationCheckpoint: (name) => {
          if (name !== "mutex-entered" || paused) return;
          paused = true;
          process.stdout.write("READY\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500);
        },
      });
      try {
        const reader = await coordinator.acquireUserStateReadLease({
          policy: { waitMs: 10000, staleMs: 20000, heartbeatMs: 1000, pollMs: 25 },
        });
        reader.release();
        process.stdout.write("DONE\n");
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(3);
      }
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      worker,
      runtimeLeaseEntry,
    ]);
    try {
      await waitForChildOutput(child, 'READY\n');
      const completed = waitForChildOutput(child, 'DONE\n', 20_000);
      void completed.catch(() => undefined);
      const cpuBefore = process.cpuUsage();
      release(lease);
      const cpu = process.cpuUsage(cpuBefore);
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(2500);
      await completed;
      expect(await inspectRuntimeLeaseState(project)).toMatchObject({
        status: 'stable',
        projectReaders: 0,
      });
    } finally {
      await stopChild(child);
    }
  }, 30_000);

  it.runIf(process.platform !== 'win32')(
    'forces private coordination modes under a restrictive umask',
    async () => {
      const coreEntry = coreEntryPath();
      const worker = String.raw`
        import { lstatSync } from "node:fs";
        import { join } from "node:path";
        import { pathToFileURL } from "node:url";
        process.umask(0o777);
        const core = await import(pathToFileURL(process.argv[1]).href);
        const lease = await core.acquireRuntimeReadLease({
          projectDir: process.argv[2],
          policy: { waitMs: 5000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
        });
        const paths = core.resolveCoordinationPaths();
        const projectPaths = paths.forProject(lease.coordinationKey);
        const modes = [
          lstatSync(paths.coordinationDir).mode & 0o777,
          lstatSync(paths.projectsDir).mode & 0o777,
          lstatSync(paths.userReadersDir).mode & 0o777,
          lstatSync(projectPaths.projectCoordinationDir).mode & 0o777,
          lstatSync(projectPaths.readersDir).mode & 0o777,
          lstatSync(join(projectPaths.readersDir, "reader-" + lease.ownerToken + ".json")).mode & 0o777,
        ];
        if (modes.slice(0, 5).some((mode) => mode !== 0o700) || modes[5] !== 0o600) {
          console.error(JSON.stringify(modes));
          process.exit(3);
        }
        lease.release();
        process.stdout.write("DONE\n");
        process.exit(0);
      `;
      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        worker,
        coreEntry,
        project,
      ]);
      try {
        await waitForChildOutput(child, 'DONE\n', 30_000);
      } finally {
        await stopChild(child);
      }
    },
  );

  it('preserves successor mutexes during concurrent stale recovery', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    privateWrite(paths.globalMutexFile, {
      ownerToken: 'stale-mutex-owner-0001',
      pid: 999_999_999,
      hostname: hostId(hostname()),
      hostIdentityProven: false,
      acquiredAt: Date.now() - 10_000,
      lastHeartbeatAt: Date.now() - 10_000,
      staleMs: 120,
    });
    const coreEntry = coreEntryPath();
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write("READY\n");
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", async (command) => {
        if (command.trim() !== "GO") process.exit(2);
        try {
          const lease = await core.acquireRuntimeReadLease({
            projectDir: process.argv[2],
            policy: { waitMs: 30000, staleMs: 120, heartbeatMs: 30, pollMs: 2 },
          });
          await new Promise((resolve) => setTimeout(resolve, 2));
          lease.release();
          process.stdout.write("DONE\n");
          process.exit(0);
        } catch (error) {
          console.error(error);
          process.exit(3);
        }
      });
    `;

    await runBarrierWorkers(worker, 12, coreEntry, project);
    expect(existsSync(paths.globalMutexFile)).toBe(false);
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      projectReaders: 0,
    });
  });

  it('returns only stable or busy while another process churns leases', async () => {
    const coreEntry = coreEntryPath();
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const core = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write("READY\n");
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", async (command) => {
        if (command.trim() !== "GO") process.exit(2);
        try {
          for (let index = 0; index < 40; index += 1) {
            const lease = await core.acquireRuntimeReadLease({
              projectDir: process.argv[2],
              policy: { waitMs: 5000, staleMs: 5000, heartbeatMs: 100, pollMs: 2 },
            });
            await new Promise((resolve) => setTimeout(resolve, 1));
            lease.release();
          }
          process.stdout.write("DONE\n");
          process.exit(0);
        } catch (error) {
          console.error(error);
          process.exit(3);
        }
      });
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      worker,
      coreEntry,
      project,
    ]);
    try {
      await waitForChildOutput(child, 'READY\n', 30_000);
      const completed = waitForChildOutput(child, 'DONE\n', 60_000);
      void completed.catch(() => undefined);
      child.stdin.write('GO\n');
      for (let index = 0; index < 80; index += 1) {
        await expect(inspectRuntimeLeaseState(project)).resolves.toMatchObject({
          status: expect.stringMatching(/^(?:busy|stable)$/u),
        });
        await Promise.resolve();
      }
      await completed;
    } finally {
      await stopChild(child);
    }
  });

  it('coordinates a reader and writer across real Node processes', async () => {
    const coreEntry = coreEntryPath();
    expect(existsSync(coreEntry)).toBe(true);
    const worker = String.raw`
      import { pathToFileURL } from 'node:url';
      const core = await import(pathToFileURL(process.argv[1]).href);
      const lease = await core.acquireRuntimeReadLease({
        projectDir: process.argv[2],
        policy: { waitMs: 1000, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
      });
      process.stdout.write('READY\n');
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (command) => {
        if (command.trim() !== 'RELEASE') process.exit(2);
        lease.release();
        process.stdout.write('DONE\n');
        process.exit(0);
      });
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      worker,
      coreEntry,
      project,
    ]);
    try {
      await waitForChildOutput(child, 'READY\n');
      await expect(
        acquireRuntimeExclusiveLease({
          projectDir: project,
          policy: { ...POLICY, waitMs: 50 },
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_EXCLUSIVE' });

      child.stdin.write('RELEASE\n');
      await waitForChildOutput(child, 'DONE\n');
      const writer = track(
        await acquireRuntimeExclusiveLease({
          projectDir: project,
          policy: POLICY,
        }),
      );
      release(writer);
    } finally {
      await stopChild(child);
    }
  });
});

describe('recovery barriers', () => {
  it('mutates the fixed promotion journal only under live writer authority', async () => {
    const key = projectCoordinationKey(project);
    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const open = JSON.stringify({
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'fixed-promotion',
      state: 'open',
    });
    await expect(
      mutateRuntimePromotionJournal(writer, {
        operation: 'create',
        content: '{}',
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' });
    expect(inspectRuntimePromotionRecoveryHeader(project)).toEqual({
      status: 'absent',
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'create',
      content: open,
    });
    expect(inspectRuntimePromotionRecoveryHeader(project)).toMatchObject({
      status: 'valid',
      state: 'open',
      operationId: 'fixed-promotion',
    });

    const projectPaths = resolveCoordinationPaths().forProject(key);
    const observedOpen = readAnchoredRecord({
      trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
      parentDir: projectPaths.projectCoordinationDir,
      basename: RUNTIME_PROMOTION_JOURNAL_FILE,
      maxBytes: 24 * 1024,
      permissionPosture: 'private',
    });
    expect(observedOpen.status).toBe('present');
    const closed = JSON.stringify({
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'fixed-promotion',
      state: 'closed',
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'replace',
      content: closed,
      expectedContentSha256: observedOpen.status === 'present' ? observedOpen.sha256 : '',
    });
    const observedClosed = readAnchoredRecord({
      trustedAnchorDir: resolveCoordinationPaths().coordinationDir,
      parentDir: projectPaths.projectCoordinationDir,
      basename: RUNTIME_PROMOTION_JOURNAL_FILE,
      maxBytes: 24 * 1024,
      permissionPosture: 'private',
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'unlink',
      expectedContentSha256: observedClosed.status === 'present' ? observedClosed.sha256 : '',
    });
    expect(inspectRuntimePromotionRecoveryHeader(project)).toEqual({
      status: 'absent',
    });

    release(writer);
    const successor = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        ownerToken: writer.ownerToken,
        policy: POLICY,
      }),
    );
    await expect(
      mutateRuntimePromotionJournal(writer, {
        operation: 'create',
        content: open,
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST' });
    release(successor);
  });

  it('reads the fixed promotion journal only with exact live writer authority', async () => {
    const key = projectCoordinationKey(project);
    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );

    await expect(readRuntimePromotionJournal(writer)).resolves.toEqual({
      status: 'absent',
    });
    const content = JSON.stringify({
      kind: 'init-promotion',
      version: RUNTIME_RECOVERY_HEADER_VERSION,
      coordinationKey: key,
      operationId: 'authority-read',
      state: 'open',
      body: { cursor: 1 },
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'create',
      content,
    });
    await expect(readRuntimePromotionJournal(writer)).resolves.toEqual({
      status: 'present',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    });

    const forged = Object.freeze({ ...writer });
    await expect(readRuntimePromotionJournal(forged)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST',
    });
    const wrongKey = Object.freeze({
      ...writer,
      coordinationKey: projectCoordinationKey(otherProject),
    });
    await expect(readRuntimePromotionJournal(wrongKey)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST',
    });

    release(writer);
    await expect(readRuntimePromotionJournal(writer)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST',
    });
  });

  it('rejects oversize and unsafe fixed promotion journal reads', async () => {
    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    writeFileSync(promotionPath(), 'x'.repeat(RUNTIME_RECOVERY_RECORD_MAX_BYTES + 1), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(promotionPath(), 0o600);
    await expect(readRuntimePromotionJournal(writer)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    rmSync(promotionPath());

    if (process.platform !== 'win32') {
      const outside = join(project, 'outside-promotion.json');
      privateWrite(outside, { secret: true });
      symlinkSync(outside, promotionPath());
      await expect(readRuntimePromotionJournal(writer)).rejects.toMatchObject({
        code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
      });
      rmSync(promotionPath());
    }

    release(writer);
  });

  it('keeps fixed promotion mutations at 24 KiB while general anchored records allow more', async () => {
    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const oversize = JSON.stringify({
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'fixed-promotion-oversize',
      state: 'open',
      padding: 'x'.repeat(RUNTIME_RECOVERY_RECORD_MAX_BYTES),
    });
    expect(Buffer.byteLength(oversize, 'utf8')).toBeGreaterThan(RUNTIME_RECOVERY_RECORD_MAX_BYTES);
    await expect(
      mutateRuntimePromotionJournal(writer, {
        operation: 'create',
        content: oversize,
      }),
    ).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    expect(existsSync(promotionPath())).toBe(false);
    release(writer);
  });

  it('detects fixed promotion parent replacement before returning journal data', async () => {
    const movedParent = join(home, 'moved-project-coordination');
    let replaceParent = false;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name !== 'before-fixed-recovery-read-parent-revalidation' || replaceParent) return;
        replaceParent = true;
        const projectPaths = resolveCoordinationPaths().forProject(projectCoordinationKey(project));
        renameSync(projectPaths.projectCoordinationDir, movedParent);
        mkdirSync(projectPaths.projectCoordinationDir, { mode: 0o700 });
        mkdirSync(projectPaths.readersDir, { mode: 0o700 });
        if (process.platform !== 'win32') {
          chmodSync(projectPaths.projectCoordinationDir, 0o700);
          chmodSync(projectPaths.readersDir, 0o700);
        }
      },
    });
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const content = JSON.stringify({
      kind: 'init-promotion',
      version: RUNTIME_RECOVERY_HEADER_VERSION,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'parent-replacement',
      state: 'open',
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'create',
      content,
    });

    await expect(readRuntimePromotionJournal(writer)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    expect(readFileSync(join(movedParent, RUNTIME_PROMOTION_JOURNAL_FILE), 'utf8')).toBe(content);
    expect(existsSync(promotionPath())).toBe(false);

    release(writer);
    rmSync(movedParent, { recursive: true, force: true });
  });

  it('durably retries a fixed journal unlink after the target vanished before parent fsync', async () => {
    let failParentFsync = true;
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name !== 'before-fixed-recovery-parent-fsync' || !failParentFsync) return;
        failParentFsync = false;
        throw new Error('injected parent fsync failure');
      },
    });
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: POLICY,
      }),
    );
    const content = JSON.stringify({
      kind: 'init-promotion',
      version: RUNTIME_RECOVERY_HEADER_VERSION,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'durable-unlink-retry',
      state: 'closed',
    });
    await mutateRuntimePromotionJournal(writer, {
      operation: 'create',
      content,
    });
    const observed = await readRuntimePromotionJournal(writer);
    expect(observed.status).toBe('present');
    const unlink = {
      operation: 'unlink' as const,
      expectedContentSha256: observed.status === 'present' ? observed.sha256 : '',
    };

    await expect(mutateRuntimePromotionJournal(writer, unlink)).rejects.toThrow(
      'injected parent fsync failure',
    );
    expect(existsSync(promotionPath())).toBe(false);
    await expect(mutateRuntimePromotionJournal(writer, unlink)).resolves.toEqual({
      strategy: 'portable-anchored',
    });
    await expect(readRuntimePromotionJournal(writer)).resolves.toEqual({
      status: 'absent',
    });

    release(writer);
  });

  it('mutates the fixed uninstall receipt only under live global authority', async () => {
    const writer = track(
      await acquireGlobalRuntimeMaintenanceLease({
        policy: POLICY,
      }),
    );
    const open = JSON.stringify({
      kind: 'user-uninstall',
      version: 1,
      operationId: 'fixed-uninstall',
      state: 'open',
    });
    await mutateUserUninstallReceipt(writer, {
      operation: 'create',
      content: open,
    });
    expect(inspectUserUninstallRecoveryHeader()).toMatchObject({
      status: 'valid',
      state: 'open',
      operationId: 'fixed-uninstall',
    });
    const paths = resolveCoordinationPaths();
    const observedOpen = readAnchoredRecord({
      trustedAnchorDir: paths.coordinationDir,
      parentDir: paths.coordinationDir,
      basename: USER_UNINSTALL_RECEIPT_FILE,
      maxBytes: 24 * 1024,
      permissionPosture: 'private',
    });
    const closed = JSON.stringify({
      kind: 'user-uninstall',
      version: 1,
      operationId: 'fixed-uninstall',
      state: 'closed',
    });
    await mutateUserUninstallReceipt(writer, {
      operation: 'replace',
      content: closed,
      expectedContentSha256: observedOpen.status === 'present' ? observedOpen.sha256 : '',
    });
    const observedClosed = readAnchoredRecord({
      trustedAnchorDir: paths.coordinationDir,
      parentDir: paths.coordinationDir,
      basename: USER_UNINSTALL_RECEIPT_FILE,
      maxBytes: 24 * 1024,
      permissionPosture: 'private',
    });
    await mutateUserUninstallReceipt(writer, {
      operation: 'unlink',
      expectedContentSha256: observedClosed.status === 'present' ? observedClosed.sha256 : '',
    });
    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
    release(writer);
  });

  it('classifies and discards an oversize promotion without reading its body', async () => {
    await createScaffold();
    writeFileSync(promotionPath(), 'x'.repeat(24 * 1024 + 1), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(promotionPath(), 0o600);
    expect(inspectRuntimePromotionRecoveryHeader(project)).toEqual({
      status: 'malformed',
      reason: 'oversize',
    });
    await expect(
      acquireRuntimeReadLease({ projectDir: project, policy: SHORT_POLICY }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.RECOVERY_REQUIRED' });

    const discard = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        posture: 'destructive-discard',
        policy: POLICY,
      }),
    );
    expect(Object.isFrozen(discard)).toBe(true);
    expect(Object.getOwnPropertySymbols(discard)).toEqual([]);
    const forgedNormalLease = { ...discard, posture: 'normal' as const };
    await expect(
      mutateRuntimePromotionJournal(forgedNormalLease, {
        operation: 'create',
        content: '{}',
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST' });
    await expect(
      mutateRuntimePromotionJournal(discard, {
        operation: 'create',
        content: '{}',
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE' });
    await expect(readRuntimePromotionJournal(discard)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE',
    });
    await expect(discardRuntimePromotionJournal(new Proxy(discard, {}))).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST',
    });
    await discardRuntimePromotionJournal(discard);
    expect(inspectRuntimePromotionRecoveryHeader(project)).toEqual({
      status: 'absent',
    });
    release(discard);
  });

  it('classifies and discards an oversize receipt without reading its body', async () => {
    await createScaffold();
    const receipt = resolveCoordinationPaths().userUninstallReceiptFile;
    writeFileSync(receipt, 'x'.repeat(24 * 1024 + 1), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(receipt, 0o600);
    expect(inspectUserUninstallRecoveryHeader()).toEqual({
      status: 'malformed',
      reason: 'oversize',
    });
    await expect(acquireUserStateReadLease({ policy: SHORT_POLICY })).rejects.toMatchObject({
      code: 'CONFIGURATION.RECOVERY_REQUIRED',
    });

    const discard = track(
      await acquireGlobalRuntimeMaintenanceLease({
        posture: 'receipt-only-discard',
        policy: POLICY,
      }),
    );
    expect(Object.isFrozen(discard)).toBe(true);
    const forgedNormalLease = {
      ...discard,
      posture: 'normal' as const,
      receiptOnlyDiscard: false as const,
    };
    await expect(
      mutateUserUninstallReceipt(forgedNormalLease, {
        operation: 'create',
        content: '{}',
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST' });
    await expect(
      mutateUserUninstallReceipt(discard, {
        operation: 'create',
        content: '{}',
      }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE' });
    await discardUserUninstallReceipt(discard);
    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
    release(discard);
  });

  it('blocks normal reads for open/malformed promotion state and permits closed cleanup', async () => {
    await createScaffold();
    const key = projectCoordinationKey(project);
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'promotion-1',
      state: 'open',
      cliOwnedBody: { ignored: true },
    });
    expect(inspectRuntimePromotionRecoveryHeader(project)).toMatchObject({
      status: 'valid',
      operationId: 'promotion-1',
      state: 'open',
    });
    await expect(
      acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.RECOVERY_REQUIRED' });

    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'promotion-1',
      state: 'closed',
      cliOwnedBody: { ignored: true },
    });
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    release(reader);

    writeFileSync(promotionPath(), '{not-json', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await expect(
      acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.RECOVERY_REQUIRED' });
  });

  it('requires matching Init recovery but lets confirmed destructive discard drain any journal', async () => {
    await createScaffold();
    const key = projectCoordinationKey(project);
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'promotion-2',
      state: 'open',
    });
    await expect(
      acquireRuntimeExclusiveLease({
        projectDir: project,
        posture: 'init-recovery',
        recoveryOperationId: 'wrong',
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.RECOVERY_REQUIRED' });
    const recovery = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        posture: 'init-recovery',
        recoveryOperationId: 'promotion-2',
        policy: POLICY,
      }),
    );
    await expect(readRuntimePromotionJournal(recovery)).resolves.toMatchObject({
      status: 'present',
      content: expect.stringContaining('"operationId":"promotion-2"'),
    });
    release(recovery);

    const discard = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        posture: 'destructive-discard',
        policy: POLICY,
      }),
    );
    release(discard);
  });

  it('combines matching Init recovery with automatic foreign-owner expiry', async () => {
    await createScaffold();
    const key = projectCoordinationKey(project);
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: key,
      operationId: 'promotion-foreign-recovery',
      state: 'open',
    });
    const readersDir = resolveCoordinationPaths().forProject(key).readersDir;
    const remotePath = join(readersDir, 'reader-init-recovery-remote-0001.json');
    privateWrite(remotePath, {
      ...readerFixture('project', 'init-recovery-remote-0001', 1),
      hostname: hostId('init-recovery-remote-host'),
      staleMs: 30,
    });
    let wallNow = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'init-recovery-local-host',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    const recovery = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        posture: 'init-recovery',
        recoveryOperationId: 'promotion-foreign-recovery',
        policy: { waitMs: 100, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    );

    expect(existsSync(remotePath)).toBe(false);
    release(recovery);
  });

  it('gates user state on the fixed receipt and limits receipt-only discard to malformed state', async () => {
    await createScaffold();
    const receipt = resolveCoordinationPaths().userUninstallReceiptFile;
    privateWrite(receipt, {
      kind: 'user-uninstall',
      version: 1,
      operationId: 'uninstall-1',
      state: 'open',
      tombstone: 'ignored-by-core',
    });
    expect(inspectUserUninstallRecoveryHeader()).toMatchObject({
      status: 'valid',
      operationId: 'uninstall-1',
      state: 'open',
    });
    await expect(acquireUserStateReadLease({ policy: POLICY })).rejects.toMatchObject({
      code: 'CONFIGURATION.RECOVERY_REQUIRED',
    });
    const recovery = track(
      await acquireGlobalRuntimeMaintenanceLease({
        posture: 'user-recovery',
        recoveryOperationId: 'uninstall-1',
        policy: POLICY,
      }),
    );
    release(recovery);

    writeFileSync(receipt, '{bad', { encoding: 'utf8', mode: 0o600 });
    const discard = track(
      await acquireGlobalRuntimeMaintenanceLease({
        posture: 'receipt-only-discard',
        policy: POLICY,
      }),
    );
    expect(discard.receiptOnlyDiscard).toBe(true);
    release(discard);

    rmSync(receipt);
    await expect(
      acquireGlobalRuntimeMaintenanceLease({
        posture: 'receipt-only-discard',
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.RECOVERY_REQUIRED' });
  });

  it('combines malformed-receipt discard with automatic foreign-owner expiry', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    writeFileSync(paths.userUninstallReceiptFile, '{not-json', {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(paths.userUninstallReceiptFile, 0o600);
    const remotePath = join(paths.userReadersDir, 'reader-receipt-discard-remote-0001.json');
    privateWrite(remotePath, {
      ...readerFixture('user', 'receipt-discard-remote-0001', 1),
      hostname: hostId('receipt-discard-remote-host'),
      staleMs: 30,
    });
    let wallNow = 5000;
    let monotonic = 0;
    const coordinator = createRuntimeLeaseCoordinator({
      now: () => wallNow,
      monotonicNow: () => monotonic,
      hostname: () => 'receipt-discard-local-host',
      poll: async (ms) => {
        wallNow += ms;
        monotonic += ms;
        await Promise.resolve();
      },
    });

    const discard = track(
      await coordinator.acquireGlobalRuntimeMaintenanceLease({
        posture: 'receipt-only-discard',
        policy: { waitMs: 100, staleMs: 30, heartbeatMs: 10, pollMs: 2 },
      }),
    );

    expect(existsSync(remotePath)).toBe(false);
    await discardUserUninstallReceipt(discard);
    release(discard);
  });

  it('allows malformed-receipt discard while a project journal awaits recovery', async () => {
    await createScaffold();
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'combined-recovery-promotion',
      state: 'open',
    });
    const receipt = resolveCoordinationPaths().userUninstallReceiptFile;
    writeFileSync(receipt, '{malformed', { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(receipt, 0o600);

    const discard = track(
      await acquireGlobalRuntimeMaintenanceLease({
        posture: 'receipt-only-discard',
        policy: POLICY,
      }),
    );
    await discardUserUninstallReceipt(discard);
    release(discard);

    expect(inspectUserUninstallRecoveryHeader()).toEqual({ status: 'absent' });
    expect(inspectRuntimePromotionRecoveryHeader(project)).toMatchObject({
      status: 'valid',
      state: 'open',
    });
  });

  it('refuses global maintenance while any project promotion journal exists', async () => {
    await createScaffold();
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'promotion-global-block',
      state: 'closed',
    });

    await expect(acquireGlobalRuntimeMaintenanceLease({ policy: POLICY })).rejects.toMatchObject({
      code: 'CONFIGURATION.RECOVERY_REQUIRED',
    });
  });

  it('blocks global maintenance when a project contains unknown live state', async () => {
    await createScaffold();
    const projectStateDir = resolveCoordinationPaths().forProject(
      projectCoordinationKey(project),
    ).projectCoordinationDir;
    privateWrite(join(projectStateDir, 'unknown-live-state.json'), {
      owner: 'unknown',
    });

    await expect(acquireGlobalRuntimeMaintenanceLease({ policy: POLICY })).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects broken symlinks that use allowed nested basenames',
    async () => {
      await createScaffold();
      const projectPaths = resolveCoordinationPaths().forProject(projectCoordinationKey(project));
      const allowedTemp = join(
        projectPaths.projectCoordinationDir,
        '.runtime-promotion.json.tmp-12345678-1234-4234-8234-123456789012',
      );
      symlinkSync(join(project, 'missing-recovery'), allowedTemp);

      expect(() => inspectRuntimePromotionRecoveryHeader(project)).toThrow(
        expect.objectContaining({
          code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
        }),
      );
      await expect(inspectRuntimeLeaseState(project)).rejects.toMatchObject({
        code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
      });
    },
  );

  it('never exposes HOME, project paths, operation IDs, or raw recovery reasons in status', async () => {
    await createScaffold();
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'secret-operation-id',
      state: 'closed',
      reason: 'secret-reason',
    });
    const rendered = JSON.stringify(await inspectRuntimeLeaseState(project));

    expect(rendered).not.toContain(home);
    expect(rendered).not.toContain(project);
    expect(rendered).not.toContain(projectCoordinationKey(project));
    expect(rendered).not.toContain('secret-operation-id');
    expect(rendered).not.toContain('secret-reason');
    expect(rendered).toContain('"state":"closed"');
  });

  it('keeps linked-create state and header evidence unchanged during read-only inspection', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const projectPaths = paths.forProject(projectCoordinationKey(project));
    const headerTemp = join(
      projectPaths.projectCoordinationDir,
      '.runtime-promotion.json.tmp-12345678-1234-4234-8234-123456789012',
    );
    privateWrite(headerTemp, {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'linked-header',
      state: 'open',
    });
    linkSync(headerTemp, projectPaths.promotionJournalFile);
    const headerBefore = {
      entries: readdirSync(projectPaths.projectCoordinationDir).sort(),
      content: readFileSync(projectPaths.promotionJournalFile, 'utf8'),
      targetLinks: lstatSync(projectPaths.promotionJournalFile).nlink,
      tempLinks: lstatSync(headerTemp).nlink,
    };

    expect(inspectRuntimePromotionRecoveryHeader(project)).toMatchObject({
      status: 'malformed',
      reason: 'unsafe-file',
    });
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      promotion: { status: 'malformed' },
    });
    expect({
      entries: readdirSync(projectPaths.projectCoordinationDir).sort(),
      content: readFileSync(projectPaths.promotionJournalFile, 'utf8'),
      targetLinks: lstatSync(projectPaths.promotionJournalFile).nlink,
      tempLinks: lstatSync(headerTemp).nlink,
    }).toEqual(headerBefore);

    rmSync(headerTemp);
    rmSync(projectPaths.promotionJournalFile);
    const stateTemp = join(
      paths.coordinationDir,
      '.state.json.tmp-12345678-1234-4234-8234-123456789012',
    );
    linkSync(paths.stateFile, stateTemp);
    const stateBefore = {
      entries: readdirSync(paths.coordinationDir).sort(),
      content: readFileSync(paths.stateFile, 'utf8'),
      targetLinks: lstatSync(paths.stateFile).nlink,
      tempLinks: lstatSync(stateTemp).nlink,
    };

    expect(inspectRuntimePromotionRecoveryHeader(project)).toEqual({
      status: 'absent',
    });
    await expect(inspectRuntimeLeaseState(project)).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    expect({
      entries: readdirSync(paths.coordinationDir).sort(),
      content: readFileSync(paths.stateFile, 'utf8'),
      targetLinks: lstatSync(paths.stateFile).nlink,
      tempLinks: lstatSync(stateTemp).nlink,
    }).toEqual(stateBefore);
  });
});

describe('anchored coordination mutation and cleanup', () => {
  it('validates the anchor and size bound even when the target is absent', () => {
    const anchor = mkdtempSync(join(tmpdir(), 'opensip-anchor-read-validation-'));
    if (process.platform !== 'win32') chmodSync(anchor, 0o700);
    try {
      expect(() =>
        readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: join(anchor, 'missing-parent'),
          basename: 'missing.json',
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
      expect(() =>
        readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'missing.json',
          maxBytes: Number.NaN,
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it('provides anchored create/read/conflict-checked replace/unlink with parent durability', () => {
    const anchor = mkdtempSync(join(tmpdir(), 'opensip-anchor-'));
    if (process.platform !== 'win32') chmodSync(anchor, 0o700);
    try {
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
        operation: 'create',
        content: '{"value":1}',
      });
      const observed = readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
      });
      expect(observed.status).toBe('present');
      const digest = observed.status === 'present' ? observed.sha256 : '';
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
        operation: 'replace',
        content: '{"value":2}',
        expectedContentSha256: digest,
      });
      const replaced = readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
      });
      expect(replaced).toMatchObject({
        status: 'present',
        content: '{"value":2}',
      });
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
        operation: 'unlink',
        expectedContentSha256: replaced.status === 'present' ? replaced.sha256 : '',
      });
      expect(
        readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'record.json',
        }),
      ).toEqual({ status: 'absent' });

      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
        operation: 'create',
        content: '{"value":1}',
      });
      const staleObservation = readAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'record.json',
      });
      writeFileSync(join(anchor, 'record.json'), '{"value":2}', {
        mode: 0o644,
      });
      expect(() =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'record.json',
          operation: 'replace',
          content: '{"value":3}',
          expectedContentSha256:
            staleObservation.status === 'present' ? staleObservation.sha256 : '',
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
        }),
      );
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'closes the anchored parent after repeated pre-publication CAS failures',
    () => {
      const anchor = mkdtempSync(join(tmpdir(), 'opensip-anchor-fd-'));
      const descriptorDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
      if (process.platform !== 'win32') chmodSync(anchor, 0o700);
      try {
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'record.json',
          operation: 'create',
          content: '{"value":1}',
        });
        const descriptorCountBefore = readdirSync(descriptorDirectory).length;
        for (let index = 0; index < 256; index += 1) {
          expect(() =>
            mutateAnchoredRecord({
              trustedAnchorDir: anchor,
              parentDir: anchor,
              basename: 'record.json',
              operation: 'replace',
              content: '{"value":2}',
              expectedContentSha256: '0'.repeat(64),
            }),
          ).toThrow(
            expect.objectContaining({
              code: 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
            }),
          );
        }
        expect(readdirSync(descriptorDirectory).length).toBeLessThanOrEqual(
          descriptorCountBefore + 2,
        );
      } finally {
        rmSync(anchor, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'closes both scaffold parents and releases when scaffold cleanup fails',
    async () => {
      const descriptorDirectory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
      let failCleanupOnce = true;
      const coordinator = createRuntimeLeaseCoordinator({
        coordinationCheckpoint: (name) => {
          if (name === 'empty-scaffold-parents-opened' && failCleanupOnce) {
            failCleanupOnce = false;
            throw new Error('injected cleanup failure');
          }
        },
      });
      const reader = track(
        await coordinator.acquireRuntimeReadLease({
          projectDir: project,
          policy: POLICY,
        }),
      );
      const descriptorCountBefore = readdirSync(descriptorDirectory).length;

      expect(() => reader.release()).not.toThrow();
      expect(readdirSync(descriptorDirectory).length).toBeLessThanOrEqual(
        descriptorCountBefore + 2,
      );

      release(reader);
    },
  );

  it('finishes writer release when empty-scaffold cleanup fails', async () => {
    let failCleanupOnce = true;
    const events: string[] = [];
    const coordinator = createRuntimeLeaseCoordinator({
      coordinationCheckpoint: (name) => {
        if (name === 'empty-scaffold-parents-opened' && failCleanupOnce) {
          failCleanupOnce = false;
          throw new Error('injected writer cleanup failure');
        }
      },
    });
    const writer = track(
      await coordinator.acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: { ...POLICY, waitMs: 200 },
        onEvent: (event) => events.push(event.kind),
      }),
    );

    expect(() => writer.release()).not.toThrow();
    expect(events).toContain('lease.release');
    expect(await inspectRuntimeLeaseState(project)).toMatchObject({
      status: 'stable',
      writer: 'none',
    });
    release(writer);
  });

  it('defers writer release after transient mutex contention', async () => {
    const events: string[] = [];
    const writer = track(
      await acquireRuntimeExclusiveLease({
        projectDir: project,
        policy: { waitMs: 50, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
        onEvent: (event) => events.push(event.kind),
      }),
    );
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const runtime = await import(pathToFileURL(process.argv[1]).href);
      let paused = false;
      const coordinator = runtime.createRuntimeLeaseCoordinator({
        coordinationCheckpoint: (name) => {
          if (name !== "mutex-entered" || paused) return;
          paused = true;
          process.stdout.write("READY\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        },
      });
      const reader = await coordinator.acquireUserStateReadLease({
        policy: { waitMs: 5000, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
      });
      reader.release();
      process.stdout.write("DONE\n");
      process.exit(0);
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      worker,
      runtimeLeaseEntryPath(),
    ]);
    try {
      await waitForChildOutput(child, 'READY\n');
      expect(() => writer.release()).toThrow(
        expect.objectContaining({ code: 'TIMEOUT.RUNTIME_COORDINATION_MUTEX' }),
      );
      await waitForChildOutput(child, 'DONE\n');
      await waitUntil(() => events.includes('lease.release'));
      expect(await inspectRuntimeLeaseState(project)).toMatchObject({
        status: 'stable',
        writer: 'none',
      });
      release(writer);
    } finally {
      await stopChild(child);
    }
  });

  it('defers distinct reentrant reader releases once after transient mutex contention', async () => {
    const events: string[] = [];
    const first = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        policy: { waitMs: 50, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
        onEvent: (event) => events.push(event.kind),
      }),
    );
    const second = track(
      await acquireRuntimeReadLease({
        projectDir: project,
        ownerToken: first.ownerToken,
        policy: { waitMs: 50, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
        onEvent: (event) => events.push(event.kind),
      }),
    );
    const worker = String.raw`
      import { pathToFileURL } from "node:url";
      const runtime = await import(pathToFileURL(process.argv[1]).href);
      let paused = false;
      const coordinator = runtime.createRuntimeLeaseCoordinator({
        coordinationCheckpoint: (name) => {
          if (name !== "mutex-entered" || paused) return;
          paused = true;
          process.stdout.write("READY\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        },
      });
      const reader = await coordinator.acquireUserStateReadLease({
        policy: { waitMs: 5000, staleMs: 5000, heartbeatMs: 100, pollMs: 5 },
      });
      reader.release();
      process.stdout.write("DONE\n");
      process.exit(0);
    `;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      worker,
      runtimeLeaseEntryPath(),
    ]);
    try {
      await waitForChildOutput(child, 'READY\n');
      expect(() => first.release()).toThrow(
        expect.objectContaining({ code: 'TIMEOUT.RUNTIME_COORDINATION_MUTEX' }),
      );
      expect(() => second.release()).toThrow(
        expect.objectContaining({ code: 'TIMEOUT.RUNTIME_COORDINATION_MUTEX' }),
      );
      await waitForChildOutput(child, 'DONE\n');
      await waitUntil(async () => {
        const state = await inspectRuntimeLeaseState(project);
        return (
          state.status === 'stable' &&
          state.projectReaders === 0 &&
          events.filter((kind) => kind === 'lease.release').length === 2
        );
      });

      first.release();
      second.release();
      expect(events.filter((kind) => kind === 'lease.release')).toHaveLength(2);
      release(first);
      release(second);
    } finally {
      await stopChild(child);
    }
  });

  it('rejects generic anchored mutation of the coordination root before it exists', () => {
    const paths = resolveCoordinationPaths();
    expect(existsSync(paths.coordinationDir)).toBe(false);
    expect(() =>
      mutateAnchoredRecord({
        trustedAnchorDir: home,
        parentDir: home,
        basename: '.opensip-cli-coordination',
        operation: 'create',
        content: '{}',
        permissionPosture: 'private',
      }),
    ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE' }));
    expect(existsSync(paths.coordinationDir)).toBe(false);
  });

  it('allows a plain coordination-root read but rejects effectful generic recovery', async () => {
    await createScaffold();
    const paths = resolveCoordinationPaths();
    const projectPaths = paths.forProject(projectCoordinationKey(project));
    const content = '{"fixed":true}';
    privateWrite(projectPaths.promotionJournalFile, JSON.parse(content));
    const plain = readAnchoredRecord({
      trustedAnchorDir: paths.coordinationDir,
      parentDir: projectPaths.projectCoordinationDir,
      basename: RUNTIME_PROMOTION_JOURNAL_FILE,
      maxBytes: RUNTIME_RECOVERY_RECORD_MAX_BYTES,
      permissionPosture: 'private',
    });
    expect(plain).toMatchObject({ status: 'present', content });

    expect(() =>
      readAnchoredRecord({
        trustedAnchorDir: paths.coordinationDir,
        parentDir: projectPaths.projectCoordinationDir,
        basename: RUNTIME_PROMOTION_JOURNAL_FILE,
        maxBytes: RUNTIME_RECOVERY_RECORD_MAX_BYTES,
        permissionPosture: 'private',
        linkedCreateRecovery: {
          effect: 'settle-linked-create',
          expectedContentSha256: createHash('sha256').update(content).digest('hex'),
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE',
      }),
    );
    expect(readFileSync(projectPaths.promotionJournalFile, 'utf8')).toBe(content);
  });

  it('detects replacement of an anchored parent before publication', () => {
    const anchor = mkdtempSync(join(tmpdir(), 'opensip-parent-replacement-'));
    const parent = join(anchor, 'parent');
    const dryParent = join(anchor, 'parent-dry-run');
    const replacedParent = join(anchor, 'parent-replaced');
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(dryParent, { mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(anchor, 0o700);
      chmodSync(parent, 0o700);
      chmodSync(dryParent, 0o700);
    }
    try {
      let dryParentReads = 0;
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        get parentDir() {
          dryParentReads += 1;
          return dryParent;
        },
        basename: 'record.json',
        operation: 'create',
        content: '{}',
      });
      let parentReads = 0;
      expect(() =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          get parentDir() {
            parentReads += 1;
            if (parentReads === dryParentReads - 2) {
              renameSync(parent, replacedParent);
              mkdirSync(parent, { mode: 0o700 });
              if (process.platform !== 'win32') chmodSync(parent, 0o700);
            }
            return parent;
          },
          basename: 'record.json',
          operation: 'create',
          content: '{}',
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
      expect(existsSync(join(parent, 'record.json'))).toBe(false);
      expect(existsSync(join(replacedParent, 'record.json'))).toBe(false);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it('detects parent replacement after replace and unlink without erasing the new path', () => {
    const run = (operation: 'replace' | 'unlink'): void => {
      const anchor = mkdtempSync(join(tmpdir(), `opensip-parent-after-${operation}-`));
      const parent = join(anchor, 'parent');
      const movedParent = join(anchor, 'parent-moved');
      mkdirSync(parent, { mode: 0o700 });
      if (process.platform !== 'win32') {
        chmodSync(anchor, 0o700);
        chmodSync(parent, 0o700);
      }
      const createInitial = (): void => {
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: parent,
          basename: 'record.json',
          operation: 'create',
          content: '{"value":"initial"}',
        });
      };
      try {
        createInitial();
        const observed = readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: parent,
          basename: 'record.json',
        });
        let dryReads = 0;
        const dryInput = {
          trustedAnchorDir: anchor,
          get parentDir() {
            dryReads += 1;
            return parent;
          },
          basename: 'record.json',
          operation,
          ...(operation === 'replace' ? { content: '{"value":"dry"}' } : {}),
          expectedContentSha256: observed.status === 'present' ? observed.sha256 : '',
        } as const;
        mutateAnchoredRecord(dryInput);

        if (operation === 'replace') {
          const dry = readAnchoredRecord({
            trustedAnchorDir: anchor,
            parentDir: parent,
            basename: 'record.json',
          });
          mutateAnchoredRecord({
            trustedAnchorDir: anchor,
            parentDir: parent,
            basename: 'record.json',
            operation: 'replace',
            content: '{"value":"initial"}',
            expectedContentSha256: dry.status === 'present' ? dry.sha256 : '',
          });
        } else {
          createInitial();
        }
        const before = readAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: parent,
          basename: 'record.json',
        });
        let reads = 0;
        expect(() =>
          mutateAnchoredRecord({
            trustedAnchorDir: anchor,
            get parentDir() {
              reads += 1;
              if (reads === dryReads) {
                renameSync(parent, movedParent);
                mkdirSync(parent, { mode: 0o700 });
                if (process.platform !== 'win32') chmodSync(parent, 0o700);
                privateWrite(join(parent, 'record.json'), {
                  value: 'replacement-parent',
                });
              }
              return parent;
            },
            basename: 'record.json',
            operation,
            ...(operation === 'replace' ? { content: '{"value":"published"}' } : {}),
            expectedContentSha256: before.status === 'present' ? before.sha256 : '',
          }),
        ).toThrow(
          expect.objectContaining({
            code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
          }),
        );
        expect(readFileSync(join(parent, 'record.json'), 'utf8')).toBe(
          JSON.stringify({ value: 'replacement-parent' }),
        );
        if (operation === 'replace') {
          expect(readFileSync(join(movedParent, 'record.json'), 'utf8')).toBe(
            '{"value":"published"}',
          );
        } else {
          expect(existsSync(join(movedParent, 'record.json'))).toBe(false);
        }
      } finally {
        rmSync(anchor, { recursive: true, force: true });
      }
    };

    run('replace');
    run('unlink');
  });

  it('recovers a proven crash between target link and temporary-link unlink', () => {
    const anchor = mkdtempSync(join(tmpdir(), 'opensip-linked-recovery-'));
    if (process.platform !== 'win32') chmodSync(anchor, 0o700);
    const target = join(anchor, 'linked-crash.json');
    const temp = join(anchor, '.linked-crash.json.tmp-12345678-1234-4234-8234-123456789012');
    privateWrite(temp, { owner: 'test' });
    linkSync(temp, target);
    expect(lstatSync(target).nlink).toBe(2);
    const content = JSON.stringify({ owner: 'test' });

    expect(() =>
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'linked-crash.json',
        operation: 'create',
        content,
        maxBytes: 4096,
        permissionPosture: 'private',
      }),
    ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.EXISTS' }));
    expect(existsSync(temp)).toBe(false);
    expect(lstatSync(target).nlink).toBe(1);
    rmSync(anchor, { recursive: true, force: true });
  });

  it('rejects root, key, and intermediate symlink traversal', async () => {
    const paths = resolveCoordinationPaths();
    symlinkSync(project, paths.coordinationDir);
    await expect(
      acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
    ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' });
    rmSync(paths.coordinationDir);

    const anchor = mkdtempSync(join(tmpdir(), 'opensip-anchor-symlink-'));
    const actual = join(anchor, 'actual');
    const alias = join(anchor, 'alias');
    mkdirSync(actual);
    if (process.platform !== 'win32') {
      chmodSync(anchor, 0o700);
      chmodSync(actual, 0o700);
    }
    symlinkSync(actual, alias);
    try {
      expect(() =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: alias,
          basename: 'record',
          operation: 'create',
          content: 'x',
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects explicit per-key and coordination-mutex symlinks',
    async () => {
      await createScaffold();
      const paths = resolveCoordinationPaths();
      const projectPaths = paths.forProject(projectCoordinationKey(project));
      rmSync(projectPaths.projectCoordinationDir, { recursive: true });
      symlinkSync(project, projectPaths.projectCoordinationDir);
      await expect(
        acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
      ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' });

      rmSync(projectPaths.projectCoordinationDir);
      mkdirSync(projectPaths.projectCoordinationDir, { mode: 0o700 });
      mkdirSync(projectPaths.readersDir, { mode: 0o700 });
      symlinkSync(project, paths.globalMutexFile);
      await expect(
        acquireRuntimeReadLease({ projectDir: project, policy: POLICY }),
      ).rejects.toMatchObject({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' });
    },
  );

  it('rejects unsafe modes and hardlinked records', async () => {
    await createScaffold();
    if (process.platform === 'win32') return;
    const paths = resolveCoordinationPaths();
    chmodSync(paths.coordinationDir, 0o755);
    await expect(listActiveRuntimeLeaseKeys()).rejects.toMatchObject({
      code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
    });
    chmodSync(paths.coordinationDir, 0o700);

    const anchor = mkdtempSync(join(tmpdir(), 'opensip-hardlink-'));
    chmodSync(anchor, 0o700);
    try {
      mutateAnchoredRecord({
        trustedAnchorDir: anchor,
        parentDir: anchor,
        basename: 'hardlinked.json',
        operation: 'create',
        content: '{}',
        maxBytes: 4096,
        permissionPosture: 'private',
      });
      linkSync(join(anchor, 'hardlinked.json'), join(anchor, 'hardlinked-copy.json'));
      expect(() =>
        mutateAnchoredRecord({
          trustedAnchorDir: anchor,
          parentDir: anchor,
          basename: 'hardlinked.json',
          operation: 'replace',
          content: '{}',
          maxBytes: 4096,
          permissionPosture: 'private',
        }),
      ).toThrow(expect.objectContaining({ code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' }));
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it('removes only a proven empty key and preserves any recovery journal', async () => {
    const reader = track(await acquireRuntimeReadLease({ projectDir: project, policy: POLICY }));
    expect(await cleanupEmptyRuntimeLeaseKey(reader.coordinationKey)).toBe('kept');
    release(reader);
    expect(await cleanupEmptyRuntimeLeaseKey(projectCoordinationKey(project))).toBe('absent');

    await createScaffold();
    expect(await cleanupEmptyRuntimeLeaseKey(projectCoordinationKey(project))).toBe('removed');

    await createScaffold();
    privateWrite(promotionPath(), {
      kind: 'init-promotion',
      version: 1,
      coordinationKey: projectCoordinationKey(project),
      operationId: 'cleanup-block',
      state: 'closed',
    });
    expect(await cleanupEmptyRuntimeLeaseKey(projectCoordinationKey(project))).toBe('kept');
    expect(existsSync(promotionPath())).toBe(true);
  });

  it('uses only fixed recovery basenames', () => {
    expect(RUNTIME_PROMOTION_JOURNAL_FILE).toBe('runtime-promotion.json');
    expect(RUNTIME_RECOVERY_HEADER_VERSION).toBe(1);
    expect(RUNTIME_RECOVERY_RECORD_MAX_BYTES).toBe(24 * 1024);
    expect(USER_UNINSTALL_RECEIPT_FILE).toBe('user-uninstall.json');
  });
});
