/**
 * Host-owned general artifact write seam.
 */

import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  SystemError,
  ToolError,
  logger as defaultLogger,
  type Logger,
} from '@opensip-cli/core';

import { writeArtifactAtomically } from './atomic-artifact-write.js';
import { resolveStateLockPolicy } from './state-lock-policy.js';

/**
 * @throws {ConfigurationError} When the target already exists as a directory.
 * @throws {Error} When filesystem metadata cannot be read for another reason.
 */
function assertWritableFileTarget(path: string): void {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      throw new ConfigurationError(
        `writeArtifact target must be a file path, not a directory: '${path}'`,
        {
          code: 'CONFIGURATION.ARTIFACT_TARGET_IS_DIRECTORY',
        },
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Build the public `cli.writeArtifact(path, bytes)` implementation. */
export function createWriteArtifactSeam(
  logger: Logger = defaultLogger,
): (path: string, bytes: string) => Promise<void> {
  return (path, bytes) =>
    Promise.resolve().then(() => {
      const target = resolve(path);
      const scope = currentScope();
      try {
        assertWritableFileTarget(target);
        writeArtifactAtomically(target, bytes, {
          policy: resolveStateLockPolicy(),
          logger: scope?.logger ?? logger,
          runId: scope?.runId,
          cwdBasename:
            scope?.projectContext?.projectRoot === undefined
              ? basename(process.cwd())
              : basename(scope.projectContext.projectRoot),
        });
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new SystemError(
          `writeArtifact failed for '${target}': ${error instanceof Error ? error.message : String(error)}`,
          { code: 'SYSTEM.ARTIFACT_WRITE_FAILED' },
        );
      }
    });
}
