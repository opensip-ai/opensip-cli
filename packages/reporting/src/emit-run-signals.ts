/**
 * emitRunSignals — the per-run cloud-egress entry point tools call after they
 * build their `CliOutput` (ADR-0008), mirroring how each engine already calls
 * `reportToCloud` for `--report-to`.
 *
 * Collects the run's signals into a `SignalBatch`, emits via the run's selected
 * `SignalSink` (a no-op for the keyless/not-entitled majority), and surfaces the
 * "Sent N signals" confirmation. Best-effort: it NEVER throws and never affects
 * the run's exit code — local persistence has already happened by the time tools
 * call this.
 */
import { execFileSync } from 'node:child_process';

import { collectSignalBatch } from './collect-batch.js';

import type { CliOutput } from '@opensip-tools/contracts';
import type { EmitResult, RepoIdentity, SignalSink } from '@opensip-tools/core';

function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined; // not a git repo / git absent → leave the field undefined
  }
}

/** Best-effort repo identity (HEAD sha + origin remote). Never throws. */
export function resolveRepoIdentity(cwd: string): RepoIdentity {
  return {
    commit: git(cwd, ['rev-parse', 'HEAD']),
    remoteUrl: git(cwd, ['config', '--get', 'remote.origin.url']),
  };
}

export interface EmitRunSignalsInput {
  readonly output: CliOutput;
  readonly tool: string;
  readonly recipe?: string;
  readonly cwd: string;
  readonly signalSink: SignalSink;
  /** Pre-resolved repo identity; resolved from `cwd` when omitted. */
  readonly repo?: RepoIdentity;
}

/** Collect a run's signals and emit them to the cloud sink; print the confirmation. */
export async function emitRunSignals(input: EmitRunSignalsInput): Promise<EmitResult> {
  try {
    const repo = input.repo ?? resolveRepoIdentity(input.cwd);
    const batch = collectSignalBatch({
      tool: input.tool,
      recipe: input.recipe,
      repo,
      output: input.output,
    });
    const result = await input.signalSink.emit(batch);
    if (result.accepted > 0) {
      const noun = result.accepted === 1 ? 'signal' : 'signals';
      process.stderr.write(`✓ Sent ${result.accepted} ${noun} to OpenSIP Cloud\n`);
    }
    return result;
  } catch {
    return { accepted: 0, authRejected: false };
  }
}
