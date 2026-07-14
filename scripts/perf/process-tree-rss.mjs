import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TABLE_TIMEOUT_MS = 1000;
const PROCESS_TREE_KILL_TIMEOUT_MS = 1000;

export async function readProcessTable(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') return [];
  const execute = options.execFileAsync ?? execFileAsync;
  const timeoutMs = options.timeoutMs ?? PROCESS_TABLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('process table timeout must be a positive safe integer');
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,rss='], {
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
  return parseProcessTable(stdout);
}

export function parseProcessTable(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidRaw, ppidRaw, rssRaw] = line.split(/\s+/);
      return {
        pid: Number.parseInt(pidRaw ?? '', 10),
        ppid: Number.parseInt(ppidRaw ?? '', 10),
        rssBytes: Number.parseInt(rssRaw ?? '', 10) * 1024,
      };
    })
    .filter(
      (row) =>
        Number.isInteger(row.pid) && Number.isInteger(row.ppid) && Number.isFinite(row.rssBytes),
    );
}

export function sumProcessTreeRss(rows, rootPid) {
  const childrenByParent = new Map();
  const rowsByPid = new Map();
  for (const row of rows) {
    rowsByPid.set(row.pid, row);
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const row = rowsByPid.get(pid);
    if (row !== undefined) total += row.rssBytes;
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }
  return total;
}

/** Capture the current descendants while the root still owns their parent links. */
export async function captureProcessDescendants(rootPid, options = {}) {
  requirePositivePid(rootPid);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return [];
  const rows = await readProcessTable({
    execFileAsync: options.execFileAsync,
    platform,
    timeoutMs: options.timeoutMs,
  });
  return processDescendantsFromTable(rows, rootPid);
}

/** Project a captured process table into the descendants of one live root. */
export function processDescendantsFromTable(rows, rootPid) {
  requirePositivePid(rootPid);
  return collectDescendants(rows, rootPid);
}

/** Best-effort signal of a previously captured PID set, deepest descendants first. */
export function signalCapturedProcesses(processIds, signal = 'SIGTERM', options = {}) {
  const killProcess = options.killProcess ?? process.kill;
  for (const pid of [...processIds].toReversed()) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      // A captured descendant may itself lead a detached process group. Signal
      // that group first so children created just after the snapshot cannot escape.
      killProcess(-pid, signal);
      continue;
    } catch {
      // Most descendants are not group leaders; fall through to their exact PID.
    }
    try {
      killProcess(pid, signal);
    } catch {
      // A captured process may already have exited; escalation remains best-effort.
    }
  }
}

export async function killProcessTree(rootPid, signal = 'SIGTERM', options = {}) {
  requirePositivePid(rootPid);
  const platform = options.platform ?? process.platform;
  const killProcess = options.killProcess ?? process.kill;
  if (platform === 'win32') {
    const execute = options.execFileAsync ?? execFileAsync;
    try {
      await execute('taskkill', ['/pid', String(rootPid), '/t', '/f'], {
        killSignal: 'SIGKILL',
        timeout: options.timeoutMs ?? PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      return true;
    } catch {
      try {
        killProcess(rootPid, signal);
      } catch {
        // taskkill and direct root termination are both best-effort.
      }
      return false;
    }
  }
  const descendants = await captureProcessDescendants(rootPid, {
    execFileAsync: options.execFileAsync,
    platform,
    timeoutMs: options.timeoutMs,
  }).catch(() => []);
  signalCapturedProcesses(descendants, signal, { killProcess });
  try {
    killProcess(rootPid, signal);
  } catch {
    // The root may already have exited; timeout cleanup is best-effort.
  }
  return true;
}

function requirePositivePid(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new RangeError('process tree root PID must be a positive safe integer');
  }
}

function collectDescendants(rows, rootPid) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return out;
}
