/**
 * Host-owned general artifact write seam.
 */

import { statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

import {
  ConfigurationError,
  currentScope,
  isPathInside,
  resolveProjectPaths,
  SystemError,
  ToolError,
  logger as defaultLogger,
  type Logger,
  type RunScope,
} from '@opensip-cli/core';

import { DEFAULT_ARTIFACT_RETENTION_KEEP, pruneArtifactRetention } from './artifact-retention.js';
import { writeArtifactAtomically } from './atomic-artifact-write.js';
import { resolveStateLockPolicy } from './state-lock-policy.js';

/** Options for {@link createWriteArtifactSeam}. */
export interface WriteArtifactSeamOptions {
  /**
   * Number of per-tool run-dirs to retain under `.runtime/artifacts/<tool>/`
   * (`cli.artifacts.keep`). Undefined → {@link DEFAULT_ARTIFACT_RETENTION_KEEP}.
   * The host prunes the store after each write whose target lives inside it.
   */
  readonly retentionKeep?: number;
}

/**
 * After a successful artifact write, prune the per-tool run-dirs IFF the target
 * lives inside the project's host-owned artifact store
 * (`.runtime/artifacts/<tool>/<runId>/<name>`). Generic writes outside the store
 * (e.g. a graph `--catalog-output` to an arbitrary path) skip pruning naturally.
 *
 * Fully defensive: a no-project run (no `projectContext`) skips; an unreadable
 * store skips; ANY prune error is logged at debug and never thrown out of the
 * write seam (a retention problem must not fail the run).
 */
function maybePruneArtifactStore(
  target: string,
  scope: RunScope | undefined,
  retentionKeep: number,
  log: Logger,
): void {
  try {
    const projectRoot = scope?.projectContext?.projectRoot;
    if (projectRoot === undefined) return; // project-less run: no store to prune
    const { artifactsDir } = resolveProjectPaths(projectRoot);
    if (!isPathInside(target, artifactsDir)) return; // not an artifact-store write
    // The dir immediately under the store is the `<tool>` segment; the substrate
    // composes `<tool>/<runId>/<name>` underneath it.
    const tool = relative(artifactsDir, target).split(sep)[0];
    if (tool === undefined || tool === '' || tool === '..') return;
    pruneArtifactRetention(tool, artifactsDir, retentionKeep);
  } catch (error) {
    log.debug({
      evt: 'state.artifact.retention.prune.skipped',
      module: 'cli:artifact-seams',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  options: WriteArtifactSeamOptions = {},
): (path: string, bytes: string) => Promise<void> {
  const retentionKeep = options.retentionKeep ?? DEFAULT_ARTIFACT_RETENTION_KEEP;
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
      // Retention runs AFTER the write succeeds and covers worker writes too (the
      // worker RPC routes through this same host seam). Never fails the run.
      maybePruneArtifactStore(target, scope, retentionKeep, scope?.logger ?? logger);
    });
}
