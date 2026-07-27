import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { compareCodePoints } from '../model/value-helpers.js';

import { safeErrorDetail } from './error-detail.js';
import { registerInterruptCleanup } from './interrupt-cleanup.js';

import type { ChildProcess } from 'node:child_process';

const MAX_PROCESS_ROWS = 100_000;
const MAX_TRACKED_DESCENDANTS = 4096;
const PROCESS_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// `ps` normally returns in well under a second, but the workspace coverage lane
// runs every package's tests concurrently; under that IO/CPU contention a 1s bound
// can be exceeded, which would mark descendant tracking unreliable. A generous but
// still-bounded ceiling avoids that spurious failure on a loaded CI runner.
const PROCESS_SNAPSHOT_TIMEOUT_MS = 15_000;
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
  /** Test-only monotonic clock seam. */
  readonly monotonicNow?: () => number;
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
  let observedRows = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    observedRows += 1;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const details = /^(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{4})\s+(.+?)\s*$/u.exec(match[5]);
    if (details === null) continue;
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
      // A system-wide `ps -ax` legitimately lists rows this observation never
      // needs to track: kernel threads (process-group id 0 on Linux, absent on
      // macOS) and the occasional transient/odd row. Skip them rather than fail
      // the whole snapshot — a spawned descendant always has a positive pid/pgid,
      // so skipping never hides one. (Throwing here made descendant observation
      // "unavailable" on Linux, where `ps -ax` includes pgid-0 kernel threads.)
      continue;
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
  // A non-empty `ps` snapshot always yields at least this process and `ps` itself.
  // Zero usable rows from non-empty output means the `ps` format itself is
  // unusable — a table-level fault we still surface.
  if (rows.length === 0 && observedRows > 0) {
    throw new Error('Agent-eval could not parse the POSIX process inventory.');
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

/** Bounded decision-evidence summary for post-run containment diagnostics. */
export type ProcessTreeIssueCondition =
  | 'alive-record'
  | 'alive-snapshot'
  | 'descendant-group-signal'
  | 'descendant-process-signal'
  | 'root-group-probe'
  | 'root-group-signal'
  | 'root-handle-signal'
  | 'sample-record'
  | 'sample-snapshot';

export interface ProcessTreeIssue {
  readonly condition: ProcessTreeIssueCondition;
  readonly count: number;
  readonly detail: string;
}

export interface ProcessTreeSummary {
  readonly issues: readonly ProcessTreeIssue[];
  readonly reliable: boolean;
  readonly rootObserved: boolean;
  readonly samples: number;
  readonly tracked: number;
}

interface MutableProcessTreeIssue {
  count: number;
  readonly detail: string;
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function expectedProcessGone(error: unknown): boolean {
  return errnoCode(error) === 'ESRCH';
}

function processTreeFailureDetail(error: unknown): string {
  const prefix = errnoCode(error) ?? (error instanceof Error ? error.name : 'UnknownFailure');
  const detail = safeErrorDetail(error) || 'unknown failure';
  return safeErrorDetail(new Error(`${prefix}: ${detail}`));
}

class DescendantTracker {
  private failed = false;
  private lastSampleCompletedAt: number | undefined;
  private successfulSamples = 0;
  private everObservedRoot = false;
  private rootIdentityInitialized = false;
  private rootObservedAlive = false;
  private rootIdentity: PosixProcessIdentity | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly issues = new Map<ProcessTreeIssueCondition, MutableProcessTreeIssue>();
  private readonly tracked = new Map<number, TrackedProcess>();

  public constructor(
    private readonly rootPid: number,
    private readonly rootProcessGroupId: number,
    private readonly snapshotProcesses: ProcessSnapshot,
    private readonly monotonicNow: () => number,
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

  /**
   * The inputs behind a containment verdict, so a "clean" result that later
   * proves wrong (e.g. an intermittent CI-only leak) arrives as a complete
   * bug report instead of an unexplained `error: undefined`.
   */
  public summary(): ProcessTreeSummary {
    return {
      issues: [...this.issues.entries()]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([condition, issue]) =>
          Object.freeze({ condition, count: issue.count, detail: issue.detail }),
        ),
      reliable: !this.failed,
      rootObserved: this.everObservedRoot,
      samples: this.successfulSamples,
      tracked: this.tracked.size,
    };
  }

  public sample(): void {
    if (this.failed) return;
    let snapshot: readonly PosixProcessIdentity[];
    try {
      snapshot = this.snapshotProcesses();
    } catch (error) {
      this.retainObservationFailure('sample-snapshot', error);
      return;
    } finally {
      this.lastSampleCompletedAt = this.monotonicNow();
    }
    try {
      this.recordDescendants(snapshot);
    } catch (error) {
      this.retainObservationFailure('sample-record', error);
    } finally {
      this.lastSampleCompletedAt = this.monotonicNow();
    }
  }

  /** Keep untrusted output volume from driving synchronous process-table scans. */
  public sampleIfDue(): void {
    if (
      this.lastSampleCompletedAt !== undefined &&
      this.monotonicNow() - this.lastSampleCompletedAt < TRACKING_INTERVAL_MS
    ) {
      return;
    }
    this.sample();
  }

  public alive(): readonly TrackedProcess[] {
    let snapshot: readonly PosixProcessIdentity[];
    try {
      snapshot = this.snapshotProcesses();
    } catch (error) {
      this.retainObservationFailure('alive-snapshot', error);
      return [];
    }
    try {
      this.recordDescendants(snapshot);
    } catch (error) {
      this.retainObservationFailure('alive-record', error);
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
      } catch (error) {
        // Individual identities below remain authoritative. ESRCH is the
        // expected race where the group exited after the inventory snapshot.
        this.retainSignalFailure('descendant-group-signal', error);
      }
    }
    for (const identity of alive) {
      try {
        killProcess(identity.pid, signal);
      } catch (error) {
        // ESRCH means the descendant exited between inventory and signalling.
        this.retainSignalFailure('descendant-process-signal', error);
      }
    }
    return alive;
  }

  public retainSignalFailure(condition: ProcessTreeIssueCondition, error: unknown): void {
    if (!expectedProcessGone(error)) this.retainIssue(condition, error);
  }

  private retainIssue(condition: ProcessTreeIssueCondition, error: unknown): void {
    const retained = this.issues.get(condition);
    if (retained === undefined) {
      this.issues.set(condition, { count: 1, detail: processTreeFailureDetail(error) });
      return;
    }
    retained.count = Math.min(Number.MAX_SAFE_INTEGER, retained.count + 1);
  }

  private retainObservationFailure(condition: ProcessTreeIssueCondition, error: unknown): void {
    this.retainIssue(condition, error);
    this.failed = true;
    this.rootObservedAlive = false;
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
    this.successfulSamples += 1;
  }

  private updateRootObservation(currentRoot: PosixProcessIdentity | undefined): boolean {
    const rootWasObservedAlive = this.rootObservedAlive;
    if (!this.rootIdentityInitialized) {
      this.rootIdentityInitialized = true;
      if (currentRoot === undefined) {
        // The root exited before the first successful process-table sample —
        // a slow `ps` on a loaded host, not an error. Its process GROUP id is
        // still known statically (the root pid), so treat this exactly like an
        // observed exit and sweep same-group survivors from THIS snapshot.
        // Returning false here instead silently waived the containment claim:
        // a TERM-ignoring descendant spawned by a fast-exiting root was never
        // tracked, never killed, and never reported — the run closed clean
        // while leaking the process.
        return true;
      }
      this.rootIdentity = currentRoot;
    }
    // A Linux root can linger as a zombie whose COMMAND mutates (e.g.
    // "[MainThread] <defunct>") before its parent reaps it: same pid, group,
    // session, and start time — different fingerprint. That row is the root's
    // corpse, not a new process, and it must count as the exit transition; a
    // sample that sees the zombie and a later sample that sees the reaped
    // absence would otherwise EACH miss the transition, permanently skipping
    // the same-group survivor sweep (the silent orphan leak observed on the
    // Linux CI lanes). True PID reuse (different start time or session) stays
    // a non-sweeping disappearance — signalling a recycled group could kill
    // an unrelated process.
    const zombieOfRoot =
      currentRoot !== undefined &&
      currentRoot.startedAt === this.rootIdentity?.startedAt &&
      currentRoot.processGroupId === this.rootIdentity.processGroupId &&
      currentRoot.posixSession === this.rootIdentity.posixSession &&
      currentRoot.commandFingerprint !== this.rootIdentity.commandFingerprint;
    this.rootObservedAlive =
      currentRoot !== undefined &&
      this.rootIdentity !== undefined &&
      sameProcessIdentity(currentRoot, this.rootIdentity);
    if (this.rootObservedAlive) this.everObservedRoot = true;
    return rootWasObservedAlive && (currentRoot === undefined || zombieOfRoot);
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
  /** Internal process-boundary registration release. */
  readonly releaseInterruptCleanup: () => void;
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
    dependencies.monotonicNow ?? performance.now.bind(performance),
  );
  tracker.start();
  let releaseInterruptCleanup = (): void => undefined;
  const tree: PosixProcessTree = Object.freeze({
    child,
    processGroupId: child.pid,
    releaseInterruptCleanup: () => releaseInterruptCleanup(),
    tracker,
  });
  releaseInterruptCleanup = registerInterruptCleanup(() =>
    signalProcessTree(tree, 'SIGKILL', dependencies),
  );
  return tree;
}

export function sampleProcessTree(tree: PosixProcessTree): void {
  tree.tracker.sample();
}

/** Sample only when the observation interval has elapsed since the last completed scan. */
export function sampleProcessTreeIfDue(tree: PosixProcessTree): void {
  tree.tracker.sampleIfDue();
}

export function stopProcessTreeTracking(tree: PosixProcessTree): void {
  tree.releaseInterruptCleanup();
  tree.tracker.stop();
}

export function processTreeTrackingReliable(tree: PosixProcessTree): boolean {
  return tree.tracker.reliable();
}

export function processTreeSummary(tree: PosixProcessTree): ProcessTreeSummary {
  return tree.tracker.summary();
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
    if (expectedProcessGone(error)) return tree.tracker.alive().length > 0;
    tree.tracker.retainSignalFailure('root-group-probe', error);
    if (errnoCode(error) === 'EPERM') return true;
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
  } catch (error) {
    tree.tracker.retainSignalFailure('root-group-signal', error);
    if (tree.child.exitCode === null && tree.child.signalCode === null) {
      try {
        if (!tree.child.kill(signal)) {
          const rejectedSignal = new Error('The retained root handle rejected the signal.');
          tree.tracker.retainSignalFailure('root-handle-signal', rejectedSignal);
        }
      } catch (childSignalError) {
        // ESRCH means the active root exited between the state check and signal.
        tree.tracker.retainSignalFailure('root-handle-signal', childSignalError);
      }
    }
  }
}
