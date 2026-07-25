/**
 * CLEAN fixture — the four shapes the rule deliberately does NOT flag. Each is
 * reduced from real code in this repo that reviewers consider correct; each
 * would be a false positive under a naive "options object has no timeout" scan.
 *
 * Expected: ZERO findings.
 */
import { spawn, execFileSync } from 'node:child_process';

/**
 * (1) Async `spawn` bounded OUT OF BAND — the shape used by
 * `graph/engine/src/cli/orchestrate/shard-runner.ts`,
 * `workspace-runner.ts` and `cli/src/commands/repair/verify-runner.ts`.
 * `spawn` has no `maxBuffer` concept at all and its options bag carries no
 * bound, yet the child IS bounded: an armed kill timer plus a capped capture.
 * Reading the options bag alone would report every one of these as unbounded.
 */
export function boundedSpawn(command: string, args: readonly string[], timeoutMs: number): void {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  killTimer.unref?.();
  child.on('close', () => clearTimeout(killTimer));
}

/** (2) Options passed as a variable — the bound may well be in there. Not guessable, so not flagged. */
export function opaqueOptionsVariable(bin: string, options: { timeout: number }): string {
  return execFileSync(bin, ['--version'], options).toString();
}

/** (3) Options literal with a spread — the real key set is not statically knowable. */
export function spreadOptions(bin: string, base: { timeout: number }, cwd: string): string {
  return execFileSync(bin, ['--version'], { ...base, cwd, encoding: 'utf8' }).toString();
}

/**
 * (4) `exec` that is NOT child_process's — `RegExp.prototype.exec` is pervasive
 * in this codebase. Binding provenance keeps it structurally out of reach.
 */
export function regexExecIsNotSubprocess(line: string): string | undefined {
  return /WorkingSetSize=(\d+)/.exec(line)?.[1];
}
