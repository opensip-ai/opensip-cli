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

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // @swallow-ok process already exited
    }
  }
}
