import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readProcessTable() {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss='], {
    maxBuffer: 1024 * 1024,
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

export async function killProcessTree(rootPid, signal = 'SIGTERM') {
  const rows = await readProcessTable().catch(() => []);
  const descendants = collectDescendants(rows, rootPid);
  for (const pid of descendants.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited; timeout cleanup is best-effort.
    }
  }
  try {
    process.kill(rootPid, signal);
  } catch {
    // The root may already have exited; timeout cleanup is best-effort.
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
  const seen = new Set();
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
