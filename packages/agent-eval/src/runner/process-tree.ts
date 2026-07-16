import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ChildProcess } from 'node:child_process';

const MAX_PROCESS_ROWS = 100_000;
const MAX_TRACKED_DESCENDANTS = 4096;
const PROCESS_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 1000;
const TRACKING_INTERVAL_MS = 200;

/** The child-process surface retained after Node reports the root process closed. */
export type KillableChild = Pick<ChildProcess, 'exitCode' | 'kill' | 'pid' | 'signalCode'>;

export interface PosixProcessIdentity {
  readonly commandFingerprint: string;
  readonly parentPid: number;
  readonly pid: number;
  readonly processGroupId: number;
  readonly posixSession: number;
  readonly startedAt: string;
}

export type ProcessSnapshot = () => readonly PosixProcessIdentity[];

/** Injectable native effects for deterministic process-tree tests. */
export interface ProcessTreeDependencies {
  readonly killProcess?: typeof process.kill;
  readonly snapshotProcesses?: ProcessSnapshot;
}

interface TrackedProcess {
  readonly commandFingerprint: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly posixSession: number;
  readonly startedAt: string;
}

function usablePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function usableProcessIdentity(identity: PosixProcessIdentity): boolean {
  return (
    usablePid(identity.pid) &&
    Number.isSafeInteger(identity.parentPid) &&
    identity.parentPid >= 0 &&
    usablePid(identity.processGroupId) &&
    Number.isSafeInteger(identity.posixSession) &&
    identity.posixSession >= 0 &&
    identity.startedAt.length > 0 &&
    /^[a-f0-9]{64}$/u.test(identity.commandFingerprint)
  );
}

function parseProcessSnapshot(stdout: string): readonly PosixProcessIdentity[] {
  const rows: PosixProcessIdentity[] = [];
  const lines = stdout.split('\n');
  if (lines.length > MAX_PROCESS_ROWS) {
    throw new Error('Agent-eval process inventory exceeded its row ceiling.');
  }
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/u.exec(line);
    if (match === null) throw new Error('Agent-eval could not parse the POSIX process inventory.');
    const details = /^(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{4})\s+(.+?)\s*$/u.exec(match[5]);
    if (details === null)
      throw new Error('Agent-eval could not parse the POSIX process inventory.');
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const processGroupId = Number(match[3]);
    const posixSession = Number(match[4]);
    const startedAt = details.slice(1, 6).join(' ');
    const command = details[6];
    if (
      !usablePid(pid) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !usablePid(processGroupId) ||
      !Number.isSafeInteger(posixSession) ||
      posixSession < 0 ||
      command.length === 0
    ) {
      throw new Error('Agent-eval observed an invalid POSIX process identity.');
    }
    rows.push(
      Object.freeze({
        commandFingerprint: createHash('sha256').update(command).digest('hex'),
        parentPid,
        pid,
        processGroupId,
        posixSession,
        startedAt,
      }),
    );
  }
  return rows;
}

function defaultProcessSnapshot(): readonly PosixProcessIdentity[] {
  const stdout = execFileSync(
    '/bin/ps',
    ['-ww', '-axo', 'pid=,ppid=,pgid=,sess=,lstart=,command='],
    {
      encoding: 'utf8',
      maxBuffer: PROCESS_SNAPSHOT_BYTES,
      timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
    },
  );
  return parseProcessSnapshot(stdout);
}

function sameProcessIdentity(
  left: Pick<
    PosixProcessIdentity,
    'commandFingerprint' | 'pid' | 'posixSession' | 'processGroupId' | 'startedAt'
  >,
  right: Pick<
    PosixProcessIdentity,
    'commandFingerprint' | 'pid' | 'posixSession' | 'processGroupId' | 'startedAt'
  >,
): boolean {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.processGroupId === right.processGroupId &&
    left.posixSession === right.posixSession &&
    left.commandFingerprint === right.commandFingerprint
  );
}

class DescendantTracker {
  private failed = false;
  private rootIdentityInitialized = false;
  private rootObservedAlive = false;
  private rootIdentity: PosixProcessIdentity | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly tracked = new Map<number, TrackedProcess>();

  public constructor(
    private readonly rootPid: number,
    private readonly rootProcessGroupId: number,
    private readonly snapshotProcesses: ProcessSnapshot,
  ) {
    this.sample();
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.sample(), TRACKING_INTERVAL_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  public reliable(): boolean {
    return !this.failed;
  }

  public sample(): void {
    if (this.failed) return;
    try {
      this.recordDescendants(this.snapshotProcesses());
    } catch {
      this.failed = true;
      this.rootObservedAlive = false;
    }
  }

  public alive(): readonly TrackedProcess[] {
    let snapshot: readonly PosixProcessIdentity[];
    try {
      snapshot = this.snapshotProcesses();
    } catch {
      this.failed = true;
      this.rootObservedAlive = false;
      return [];
    }
    try {
      this.recordDescendants(snapshot);
    } catch {
      this.failed = true;
      this.rootObservedAlive = false;
    }
    const byPid = new Map(snapshot.map((identity) => [identity.pid, identity]));
    return [...this.tracked.values()].filter((tracked) => {
      const current = byPid.get(tracked.pid);
      return current !== undefined && sameProcessIdentity(tracked, current);
    });
  }

  public rootIdentityIsCurrent(): boolean {
    return this.rootObservedAlive;
  }

  public signal(
    signal: NodeJS.Signals,
    killProcess: typeof process.kill,
  ): readonly TrackedProcess[] {
    const alive = this.alive();
    const detachedGroups = new Set(
      alive
        .map((identity) => identity.processGroupId)
        .filter((groupId) => groupId !== this.rootProcessGroupId),
    );
    for (const groupId of detachedGroups) {
      try {
        killProcess(-groupId, signal);
      } catch {
        // Individual identities below remain authoritative.
      }
    }
    for (const identity of alive) {
      try {
        killProcess(identity.pid, signal);
      } catch {
        // The descendant may have exited between inventory and signalling.
      }
    }
    return alive;
  }

  private recordDescendants(snapshot: readonly PosixProcessIdentity[]): void {
    if (snapshot.length > MAX_PROCESS_ROWS) {
      throw new Error('Agent-eval process inventory exceeded its row ceiling.');
    }
    if (snapshot.some((identity) => !usableProcessIdentity(identity))) {
      throw new Error('Agent-eval observed an invalid POSIX process identity.');
    }
    const byPid = new Map(snapshot.map((identity) => [identity.pid, identity]));
    if (byPid.size !== snapshot.length) {
      throw new Error('Agent-eval observed duplicate POSIX process identities.');
    }
    const rootExitedThisSample = this.updateRootObservation(byPid.get(this.rootPid));
    const currentTracked = this.validatedTrackedPids(byPid);
    if (this.rootObservedAlive) currentTracked.add(this.rootPid);
    if (rootExitedThisSample) this.retainOriginalGroupMembers(snapshot, currentTracked);
    this.expandDescendants(snapshot, currentTracked);
  }

  private updateRootObservation(currentRoot: PosixProcessIdentity | undefined): boolean {
    const rootWasObservedAlive = this.rootObservedAlive;
    if (!this.rootIdentityInitialized) {
      this.rootIdentityInitialized = true;
      if (currentRoot === undefined) {
        // A short-lived utility may exit before the first bounded process-table
        // sample. Its closed stdio/root handle still settle normally, but no
        // descendant-containment claim is made for that unobserved interval.
        return false;
      }
      this.rootIdentity = currentRoot;
    }
    this.rootObservedAlive =
      currentRoot !== undefined &&
      this.rootIdentity !== undefined &&
      sameProcessIdentity(currentRoot, this.rootIdentity);
    return currentRoot === undefined && rootWasObservedAlive;
  }

  private validatedTrackedPids(byPid: ReadonlyMap<number, PosixProcessIdentity>): Set<number> {
    const currentTracked = new Set<number>();
    for (const tracked of this.tracked.values()) {
      const current = byPid.get(tracked.pid);
      if (current !== undefined && sameProcessIdentity(tracked, current))
        currentTracked.add(tracked.pid);
      else {
        // A mismatched identity is either a recycled PID or a process that
        // changed an identity facet. In both cases, fail safe by forgetting it:
        // signalling that PID/group could terminate an unrelated process.
        this.tracked.delete(tracked.pid);
      }
    }
    return currentTracked;
  }

  private retainOriginalGroupMembers(
    snapshot: readonly PosixProcessIdentity[],
    currentTracked: Set<number>,
  ): void {
    for (const identity of snapshot) {
      if (identity.pid !== this.rootPid && identity.processGroupId === this.rootProcessGroupId) {
        this.retainIdentity(identity);
        currentTracked.add(identity.pid);
      }
    }
  }

  private expandDescendants(
    snapshot: readonly PosixProcessIdentity[],
    currentTracked: Set<number>,
  ): void {
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const identity of snapshot) {
        if (
          identity.pid === this.rootPid ||
          currentTracked.has(identity.pid) ||
          !currentTracked.has(identity.parentPid)
        ) {
          continue;
        }
        this.retainIdentity(identity);
        currentTracked.add(identity.pid);
        discovered = true;
      }
    }
  }

  private retainIdentity(identity: PosixProcessIdentity): void {
    if (!this.tracked.has(identity.pid) && this.tracked.size >= MAX_TRACKED_DESCENDANTS) {
      throw new Error('Agent-eval descendant inventory exceeded its identity ceiling.');
    }
    this.tracked.set(
      identity.pid,
      Object.freeze({
        commandFingerprint: identity.commandFingerprint,
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        posixSession: identity.posixSession,
        startedAt: identity.startedAt,
      }),
    );
  }
}

/**
 * Stable root process-group plus descendant identities observed after spawn.
 * PID reuse checks combine the process-table start time with process group,
 * session, and a fingerprint of the full command (including its executable).
 * Those extra facets reduce the one-second `ps lstart` collision window but
 * cannot mathematically eliminate it without a native, kernel-issued identity.
 * The tracker can retain a detached/new-session descendant only when a sample
 * sees it before reparenting. This is cleanup assistance, not OS containment.
 */
export interface PosixProcessTree {
  readonly child: KillableChild;
  readonly processGroupId: number;
  readonly tracker: DescendantTracker;
}

/**
 * Capture POSIX process identity and start bounded descendant observation.
 * A child that forks into a new session and disappears from the root lineage
 * between samples can escape observation. Windows is rejected because Node
 * does not expose the Job Object primitive needed for stronger containment.
 */
export function retainPosixProcessTree(
  child: KillableChild,
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessTreeDependencies = {},
): PosixProcessTree {
  if (platform === 'win32') {
    throw new Error(
      'Agent-eval requires POSIX process-group cleanup; Windows Job Object containment is unavailable.',
    );
  }
  if (!usablePid(child.pid)) {
    throw new Error('Agent-eval could not retain a usable child process-group identity.');
  }
  const tracker = new DescendantTracker(
    child.pid,
    child.pid,
    dependencies.snapshotProcesses ?? defaultProcessSnapshot,
  );
  tracker.start();
  return Object.freeze({ child, processGroupId: child.pid, tracker });
}

export function sampleProcessTree(tree: PosixProcessTree): void {
  tree.tracker.sample();
}

export function stopProcessTreeTracking(tree: PosixProcessTree): void {
  tree.tracker.stop();
}

export function processTreeTrackingReliable(tree: PosixProcessTree): boolean {
  return tree.tracker.reliable();
}

/** Return whether the root group or any retained descendant identity is alive. */
export function processTreeIsAlive(
  tree: PosixProcessTree,
  dependencies: ProcessTreeDependencies = {},
): boolean {
  const observedDescendants = tree.tracker.alive();
  if (observedDescendants.length > 0) return true;
  const rootHandleIsActive = tree.child.exitCode === null && tree.child.signalCode === null;
  if (!rootHandleIsActive && !tree.tracker.rootIdentityIsCurrent()) {
    return false;
  }
  try {
    (dependencies.killProcess ?? process.kill)(-tree.processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') return true;
  }
  return tree.tracker.alive().length > 0;
}

/** Signal the retained root group and every observed descendant identity. */
export function signalProcessTree(
  tree: PosixProcessTree,
  signal: NodeJS.Signals,
  dependencies: ProcessTreeDependencies = {},
): void {
  const killProcess = dependencies.killProcess ?? process.kill.bind(process);
  const observedDescendants = tree.tracker.signal(signal, killProcess);
  const rootGroupIsRetained =
    (tree.child.exitCode === null && tree.child.signalCode === null) ||
    tree.tracker.rootIdentityIsCurrent() ||
    observedDescendants.some((identity) => identity.processGroupId === tree.processGroupId);
  if (!rootGroupIsRetained) return;
  try {
    killProcess(-tree.processGroupId, signal);
  } catch {
    if (tree.child.exitCode === null && tree.child.signalCode === null) {
      try {
        tree.child.kill(signal);
      } catch {
        // The active root may have exited between the state check and signal.
      }
    }
  }
}
