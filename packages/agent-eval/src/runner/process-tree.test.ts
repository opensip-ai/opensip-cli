import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  processTreeIsAlive,
  processTreeTrackingReliable,
  retainPosixProcessTree,
  sampleProcessTree,
  signalProcessTree,
  stopProcessTreeTracking,
  type KillableChild,
  type PosixProcessTree,
} from './process-tree.js';

const retainedTrees: PosixProcessTree[] = [];

function retainForTest(child: KillableChild, platform: NodeJS.Platform): PosixProcessTree {
  const tree = retainPosixProcessTree(child, platform, {
    snapshotProcesses: () =>
      child.pid === undefined
        ? []
        : [
            {
              commandFingerprint: 'a'.repeat(64),
              parentPid: 1,
              pid: child.pid,
              processGroupId: child.pid,
              posixSession: child.pid,
              startedAt: 'test-root-start',
            },
          ],
  });
  retainedTrees.push(tree);
  return tree;
}

afterEach(() => {
  for (const tree of retainedTrees.splice(0)) stopProcessTreeTracking(tree);
});

function fakeChild(pid: number | undefined = 4242): {
  readonly child: KillableChild;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn(() => true);
  return {
    child: { exitCode: null, kill, pid, signalCode: null },
    kill,
  };
}

describe('retained POSIX process trees', () => {
  it('fails closed on Windows instead of claiming containment without Job Objects', () => {
    expect(() => retainForTest(fakeChild().child, 'win32')).toThrow(/Job Object/u);
  });

  it('rejects a child without a usable process-group id', () => {
    const child = {
      exitCode: null,
      kill: vi.fn(() => true),
      pid: undefined,
      signalCode: null,
    };
    expect(() => retainForTest(child, 'linux')).toThrow(/process-group identity/u);
  });

  it('retains the process group independently from root-process lifetime', () => {
    const { child } = fakeChild();
    const tree = retainForTest(child, 'darwin');
    const killProcess = vi.fn();

    expect(processTreeIsAlive(tree, { killProcess })).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(-4242, 0);

    signalProcessTree(tree, 'SIGTERM', { killProcess });
    expect(killProcess).toHaveBeenLastCalledWith(-4242, 'SIGTERM');
  });

  it('falls back to the retained root handle if group signalling fails', () => {
    const retained = fakeChild();
    const tree = retainForTest(retained.child, 'linux');

    signalProcessTree(tree, 'SIGKILL', {
      killProcess: () => {
        throw new Error('group already gone');
      },
    });

    expect(retained.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('treats ESRCH as gone and EPERM as still alive', () => {
    const tree = retainForTest(fakeChild().child, 'linux');
    expect(
      processTreeIsAlive(tree, {
        killProcess: () => {
          const error = new Error('gone') as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        },
      }),
    ).toBe(false);
    expect(
      processTreeIsAlive(tree, {
        killProcess: () => {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }),
    ).toBe(true);
  });

  it('retains root-group cleanup but marks failed descendant sampling as unavailable', () => {
    const retained = fakeChild();
    const tree = retainPosixProcessTree(retained.child, 'linux', {
      snapshotProcesses: () => {
        throw new Error('process inventory unavailable');
      },
    });
    retainedTrees.push(tree);
    const killProcess = vi.fn();

    expect(processTreeTrackingReliable(tree)).toBe(false);
    signalProcessTree(tree, 'SIGTERM', { killProcess });
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('fails closed when a same-second retained PID has a different command fingerprint', () => {
    const root = {
      commandFingerprint: 'a'.repeat(64),
      parentPid: 1,
      pid: 100,
      processGroupId: 100,
      posixSession: 100,
      startedAt: 'root-start',
    };
    const snapshots = [
      [
        root,
        {
          commandFingerprint: 'b'.repeat(64),
          parentPid: 100,
          pid: 200,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'old-child-start',
        },
      ],
      [
        root,
        {
          commandFingerprint: 'c'.repeat(64),
          parentPid: 1,
          pid: 200,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'old-child-start',
        },
        {
          commandFingerprint: 'd'.repeat(64),
          parentPid: 200,
          pid: 300,
          processGroupId: 200,
          posixSession: 200,
          startedAt: 'unrelated-child-start',
        },
      ],
    ] as const;
    let snapshotIndex = 0;
    const retained = fakeChild(100);
    const tree = retainPosixProcessTree(retained.child, 'linux', {
      snapshotProcesses: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    });
    retainedTrees.push(tree);
    const killProcess = vi.fn();

    signalProcessTree(tree, 'SIGTERM', { killProcess });

    expect(killProcess).toHaveBeenCalledWith(-100, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(-200, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(300, 'SIGTERM');
    expect(processTreeTrackingReliable(tree)).toBe(true);
  });

  it('does not signal a reused root process group after the retained root exited', () => {
    const snapshots = [
      [
        {
          commandFingerprint: 'a'.repeat(64),
          parentPid: 1,
          pid: 100,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'retained-root-start',
        },
      ],
      [
        {
          commandFingerprint: 'b'.repeat(64),
          parentPid: 1,
          pid: 100,
          processGroupId: 100,
          posixSession: 200,
          startedAt: 'reused-root-start',
        },
      ],
    ] as const;
    let snapshotIndex = 0;
    const kill = vi.fn(() => true);
    const child: KillableChild = {
      exitCode: 0,
      kill,
      pid: 100,
      signalCode: null,
    };
    const tree = retainPosixProcessTree(child, 'linux', {
      snapshotProcesses: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    });
    retainedTrees.push(tree);
    const killProcess = vi.fn();

    signalProcessTree(tree, 'SIGKILL', { killProcess });

    expect(killProcess).not.toHaveBeenCalledWith(-100, 'SIGKILL');
    expect(kill).not.toHaveBeenCalled();
  });

  it('sweeps same-group survivors when the first sample already misses the root', () => {
    // The flake that redded main on a docs-only commit: a fast-exiting root
    // spawned a TERM-ignoring descendant, the loaded runner's first `ps`
    // returned only after the root died, and the tracker silently waived the
    // containment claim — the run closed clean while the descendant leaked.
    // The root's process-group id is known statically (the root pid), so the
    // first successful sample must sweep group survivors instead.
    const kill = vi.fn(() => true);
    const child: KillableChild = { exitCode: 0, kill, pid: 100, signalCode: null };
    const tree = retainPosixProcessTree(child, 'linux', {
      snapshotProcesses: () => [
        {
          commandFingerprint: 'c'.repeat(64),
          parentPid: 1, // reparented to init after the root died
          pid: 150,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'orphan-descendant-start',
        },
      ],
    });
    retainedTrees.push(tree);

    expect(processTreeTrackingReliable(tree)).toBe(true);
    const killProcess = vi.fn();
    expect(processTreeIsAlive(tree, { killProcess })).toBe(true);
    signalProcessTree(tree, 'SIGKILL', { killProcess });
    expect(killProcess).toHaveBeenCalledWith(150, 'SIGKILL');
  });

  it('treats a command-mutated root zombie as the exit transition and sweeps its group', () => {
    // The Linux CI silent-leak mode: the exited root lingers as a zombie whose
    // command mutates ("[MainThread] <defunct>") — same pid/group/session/
    // start time, different fingerprint. The zombie sample must fire the
    // same-group survivor sweep; treating it as "root still present" skipped
    // the transition on that sample AND on the post-reap sample, so a
    // TERM-ignoring descendant was never tracked and the run closed clean.
    const liveRoot = {
      commandFingerprint: 'a'.repeat(64),
      parentPid: 1,
      pid: 100,
      processGroupId: 100,
      posixSession: 100,
      startedAt: 'retained-root-start',
    };
    const zombieRoot = { ...liveRoot, commandFingerprint: 'f'.repeat(64) };
    const descendant = {
      commandFingerprint: 'b'.repeat(64),
      parentPid: 1, // already reparented to init
      pid: 150,
      processGroupId: 100,
      posixSession: 100,
      startedAt: 'descendant-start',
    };
    const snapshots = [[liveRoot], [zombieRoot, descendant], [descendant]] as const;
    let snapshotIndex = 0;
    const kill = vi.fn(() => true);
    const child: KillableChild = { exitCode: 0, kill, pid: 100, signalCode: null };
    const tree = retainPosixProcessTree(child, 'linux', {
      snapshotProcesses: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    });
    retainedTrees.push(tree);

    sampleProcessTree(tree);

    expect(processTreeTrackingReliable(tree)).toBe(true);
    const killProcess = vi.fn();
    expect(processTreeIsAlive(tree, { killProcess })).toBe(true);
    signalProcessTree(tree, 'SIGKILL', { killProcess });
    expect(killProcess).toHaveBeenCalledWith(150, 'SIGKILL');
  });

  it('retains original group members observed as the root exits', () => {
    const snapshots = [
      [
        {
          commandFingerprint: 'a'.repeat(64),
          parentPid: 1,
          pid: 100,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'retained-root-start',
        },
      ],
      [
        {
          commandFingerprint: 'b'.repeat(64),
          parentPid: 1,
          pid: 200,
          processGroupId: 100,
          posixSession: 100,
          startedAt: 'retained-group-child-start',
        },
      ],
    ] as const;
    let snapshotIndex = 0;
    const kill = vi.fn(() => true);
    const child: KillableChild = {
      exitCode: 0,
      kill,
      pid: 100,
      signalCode: null,
    };
    const tree = retainPosixProcessTree(child, 'linux', {
      snapshotProcesses: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    });
    retainedTrees.push(tree);
    const killProcess = vi.fn();

    signalProcessTree(tree, 'SIGTERM', { killProcess });

    expect(killProcess).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(killProcess).toHaveBeenCalledWith(-100, 'SIGTERM');
  });
});
