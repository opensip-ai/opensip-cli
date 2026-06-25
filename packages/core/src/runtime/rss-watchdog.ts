/**
 * RSS watchdog — sample child RSS and SIGKILL when over ceiling (DD2).
 *
 * Uses `ps` on POSIX (no extra dependency). Windows sampling is best-effort via
 * `wmic`; when unavailable the watchdog is a no-op (documented fallback).
 */

import { execFileSync, type ChildProcess } from 'node:child_process';

import { killTree } from './kill-tree.js';

/** Read child RSS in bytes, or undefined when the sample is unavailable. */
export function readChildRssBytes(pid: number): number | undefined {
  if (!Number.isFinite(pid) || pid <= 0) return undefined;

  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `ProcessId=${String(pid)}`, 'get', 'WorkingSetSize', '/value'],
        { encoding: 'utf8' },
      );
      const match = /WorkingSetSize=(\d+)/.exec(out);
      if (match === null) return undefined;
      return Number.parseInt(match[1] ?? '', 10);
    } catch {
      // @swallow-ok wmic may be unavailable or the child may have already exited
      return undefined;
    }
  }

  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const kb = Number.parseInt(out, 10);
    if (!Number.isFinite(kb) || kb <= 0) return undefined;
    return kb * 1024;
  } catch {
    // @swallow-ok ps may race with child exit; treat unavailable sample as no-op
    return undefined;
  }
}

export interface RssWatchdogHandle {
  readonly stop: () => void;
}

/**
 * Poll child RSS every `intervalMs` and kill the tree when over `maxRssMb`.
 * Returns a stop handle; call it on settle.
 */
export function startRssWatchdog(args: {
  readonly child: ChildProcess;
  readonly maxRssMb: number;
  readonly intervalMs?: number;
  readonly onExceeded: () => void;
}): RssWatchdogHandle {
  const intervalMs = args.intervalMs ?? 500;
  const maxBytes = args.maxRssMb * 1024 * 1024;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    const pid = args.child.pid;
    if (pid === undefined) return;
    const rss = readChildRssBytes(pid);
    if (rss === undefined || rss <= maxBytes) return;
    stopped = true;
    clearInterval(timer);
    killTree(args.child, 'SIGKILL');
    args.onExceeded();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
