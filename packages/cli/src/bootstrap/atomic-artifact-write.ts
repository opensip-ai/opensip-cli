/**
 * atomic-artifact-write — per-target file locks plus temp-file-and-rename writes.
 *
 * Owns SARIF and baseline fingerprint JSON exports at the CLI composition root.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  currentScope,
  generateUUID,
  withFileLock,
  type Logger,
  type StateLockPolicy,
} from '@opensip-cli/core';

import { createStateLockEventBridge } from './state-lock-policy.js';

export interface ArtifactWriteContext {
  readonly policy: StateLockPolicy;
  readonly logger: Logger;
  readonly runId?: string;
  readonly command?: string;
  readonly cwdBasename?: string;
}

/**
 * Write bytes to `targetPath` atomically under a per-target file lock.
 * Creates parent directories; cleans up temp files on failure.
 */
export function writeArtifactAtomically(
  targetPath: string,
  bytes: string,
  ctx: ArtifactWriteContext,
): void {
  const dir = dirname(targetPath);
  const lockPath = `${targetPath}.artifact.lock`;
  const tempPath = join(dir, `.${generateUUID()}.tmp`);

  mkdirSync(dir, { recursive: true });
  withFileLock(
    lockPath,
    {
      policy: ctx.policy,
      resource: 'artifact',
      operation: 'artifact.write',
      runId: ctx.runId,
      command: ctx.command,
      cwdBasename: ctx.cwdBasename,
      onEvent: createStateLockEventBridge(ctx.logger),
    },
    () => {
      try {
        // Owner-only read/write (0600). Artifacts can carry findings (and, for
        // external scanners, redacted-but-sensitive context), so they are never
        // group/world-readable. The open mode is umask-masked on some platforms,
        // so we also chmod the rename target below (belt-and-suspenders).
        const fd = openSync(tempPath, 'w', 0o600);
        try {
          writeSync(fd, bytes);
        } finally {
          closeSync(fd);
        }
        renameSync(tempPath, targetPath);
        chmodSync(targetPath, 0o600);
        ctx.logger.info({
          evt: 'state.artifact.write.complete',
          module: 'cli:atomic-artifact-write',
          operation: 'artifact.write',
        });
        // Mirror the lock/baseline bridges: surface the state-plane event on the
        // run diagnostics `persist` phase too (the contract doc lists it there).
        currentScope()?.diagnostics?.event('persist', 'info', 'state.artifact.write.complete', {
          operation: 'artifact.write',
        });
      } catch (error) {
        try {
          unlinkSync(tempPath);
        } catch {
          /* best-effort */
        }
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error({
          evt: 'state.artifact.write.error',
          module: 'cli:atomic-artifact-write',
          error: message,
        });
        currentScope()?.diagnostics?.event('persist', 'error', 'state.artifact.write.error', {
          operation: 'artifact.write',
        });
        throw error;
      }
    },
  );
}
