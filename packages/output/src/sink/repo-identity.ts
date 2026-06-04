// @fitness-ignore-file error-handling-quality -- best-effort repo-identity detection (ADR-0008): a missing git binary, a non-repo cwd, or a spawn failure must degrade silently to an undefined field; it never blocks, slows, or fails the user's run.
/**
 * resolveRepoIdentity — best-effort git repo identity (HEAD sha + origin
 * remote) for cloud signal egress (ADR-0008).
 *
 * The composition root resolves this once per run and threads it into
 * `deliverEnvelope`, so the cloud `SignalBatch` carries provenance. Pure
 * inputs in, no throw: any git failure leaves the field `undefined`.
 */
import { execFileSync } from 'node:child_process';

import type { RepoIdentity } from '@opensip-tools/core';

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
