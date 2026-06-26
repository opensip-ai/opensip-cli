/**
 * atomic-artifact-write — per-target file locks plus temp-file-and-rename writes.
 *
 * Owns SARIF and baseline fingerprint JSON exports at the CLI composition root.
 */

import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateUUID, withFileLock, type Logger, type StateLockPolicy } from '@opensip-cli/core';

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
      mkdirSync(dir, { recursive: true });
      try {
        const fd = openSync(tempPath, 'w');
        try {
          writeSync(fd, bytes);
        } finally {
          closeSync(fd);
        }
        renameSync(tempPath, targetPath);
        ctx.logger.info({
          evt: 'state.artifact.write.complete',
          module: 'cli:atomic-artifact-write',
          operation: 'artifact.write',
        });
      } catch (error) {
        try {
          unlinkSync(tempPath);
        } catch {
          /* best-effort */
        }
        ctx.logger.error({
          evt: 'state.artifact.write.error',
          module: 'cli:atomic-artifact-write',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );
}
