/**
 * Host-owned general artifact write seam.
 */

import { mkdirSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

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
    // A12: pass the current run id so its own dir is never pruned, and let the
    // grace-window floor protect concurrent in-flight peers.
    pruneArtifactRetention(tool, artifactsDir, retentionKeep, { currentRunId: scope?.runId });
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

/**
 * Owner-only mode for the host-owned per-run artifact directory (A7).
 *
 * The dir holds a scanner's raw report, which can carry live secrets/matches.
 * Creating it `0o700` means even a report file the scanner writes at its default
 * umask (typically 0644) is not world-readable, because no other user can
 * traverse the parent dir — closing the window between the scanner's first write
 * and the host's `0o600` re-write through {@link createWriteArtifactSeam}.
 */
const ARTIFACT_DIR_MODE = 0o700;

/**
 * Build the public `cli.ensureArtifactDir(artifactPath)` implementation
 * (ADR-0091; External Tool Adapter A1/A7).
 *
 * Creates `dirname(artifactPath)` recursively at {@link ARTIFACT_DIR_MODE}. This
 * is the HOST seam a tool calls BEFORE handing the path to an external scanner as
 * its output target, so the per-run dir exists for a scanner that does a bare
 * `open(path, 'w')`. Idempotent (`recursive: true`); a pre-existing dir keeps its
 * mode (only freshly-created dirs get `0o700`, which is exactly the per-run dir).
 */
export function createEnsureArtifactDirSeam(
  logger: Logger = defaultLogger,
): (artifactPath: string) => Promise<void> {
  return (artifactPath) =>
    Promise.resolve().then(() => {
      const dir = dirname(resolve(artifactPath));
      try {
        mkdirSync(dir, { recursive: true, mode: ARTIFACT_DIR_MODE });
      } catch (error) {
        throw new SystemError(
          `ensureArtifactDir failed for '${dir}': ${error instanceof Error ? error.message : String(error)}`,
          { code: 'SYSTEM.ARTIFACT_DIR_FAILED' },
        );
      }
      logger.debug({ evt: 'state.artifact.dir.ensured', module: 'cli:artifact-seams', dir });
    });
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
