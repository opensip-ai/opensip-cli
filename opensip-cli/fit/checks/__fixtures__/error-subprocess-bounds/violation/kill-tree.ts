/**
 * VIOLATION fixture — reduced from the real confirmed site
 * `packages/core/src/runtime/kill-tree.ts:23`, the kernel's process-teardown
 * descendant walk. Unchanged shape: the only option is `encoding`.
 *
 * This one is worse than it looks: the walk is RECURSIVE (one blocking `pgrep`
 * per descendant) and runs during teardown, so a single hung `pgrep` wedges the
 * process exactly when the CLI is trying to clean up. `packages/core`'s own
 * `host-process-identity.ts` calls `/bin/ps` with both `maxBuffer` and
 * `timeout` — the kernel already knows the right form.
 *
 * Expected: exactly ONE finding, on the `execFileSync` line below.
 */
import { execFileSync } from 'node:child_process';

export function descendantPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
    });
    const children = out
      .split(/\s+/)
      .map((raw) => Number.parseInt(raw, 10))
      .filter((childPid) => Number.isFinite(childPid) && childPid > 0);
    return children.flatMap((childPid) => [childPid, ...descendantPids(childPid)]);
  } catch {
    return [];
  }
}
