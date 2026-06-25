/**
 * killTree — terminate a forked worker and its whole descendant tree (DD3).
 *
 * POSIX: fork with `detached: true` so the child becomes a process-group leader;
 * kill via `process.kill(-pgid, signal)`.
 * Windows: `taskkill /PID <pid> /T /F` (required — not a degraded single-child kill).
 */

import { execFileSync, type ChildProcess } from 'node:child_process';

function isWindows(): boolean {
  return process.platform === 'win32';
}

function signalToTaskkillForce(signal: NodeJS.Signals | number): boolean {
  if (typeof signal === 'number') return signal === 9;
  return signal === 'SIGKILL' || signal === 'SIGTERM';
}

function descendantPids(pid: number): readonly number[] {
  if (isWindows()) return [];
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    const children = out
      .split(/\s+/)
      .map((raw) => Number.parseInt(raw, 10))
      .filter((childPid) => Number.isFinite(childPid) && childPid > 0);
    return children.flatMap((childPid) => [childPid, ...descendantPids(childPid)]);
  } catch {
    // @swallow-ok pgrep exits non-zero when the process has no children or already exited
    return [];
  }
}

function killProcessOrGroup(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // @swallow-ok process may not be a group leader; fall through to direct pid kill
  }
  try {
    process.kill(pid, signal);
  } catch {
    // @swallow-ok process already exited
  }
}

/**
 * Kill `child` and every descendant. Safe to call when the child has already exited.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals | number = 'SIGTERM'): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    try {
      child.kill(signal);
    } catch {
      // @swallow-ok child already exited
    }
    return;
  }

  if (isWindows()) {
    try {
      const force = signalToTaskkillForce(signal) ? ['/F'] : [];
      execFileSync('taskkill', ['/PID', String(pid), '/T', ...force], { stdio: 'ignore' });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // @swallow-ok process already exited
      }
    }
    return;
  }

  const descendants = [...descendantPids(pid)].sort((a, b) => b - a);
  for (const descendant of descendants) {
    killProcessOrGroup(descendant, signal);
  }
  killProcessOrGroup(pid, signal);
}
