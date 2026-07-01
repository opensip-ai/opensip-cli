/**
 * pre-action-guards — the pure bailout / warning guards the bootstrap
 * `preAction` hook runs inside its decision window, BEFORE any side effect
 * fires (see `pre-action-hook.ts` for the load-bearing ordering).
 *
 * Extracted from `pre-action-hook.ts` as a cohesive unit: each guard is a
 * `(project, …) => void` that either exits the process with an actionable
 * message (schema-too-old, no-project) or warns to stderr (phantom runtimes),
 * and nothing else. Housing them here keeps the hook module focused on the
 * orchestration sequence and the per-tool `initialize()` lifecycle.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  checkSchemaCompat,
  detectPhantomRuntimes,
  logger,
  readConfigSchemaVersion,
  type ProjectContext,
} from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';
import { formatCliTooOldMessage, formatNoProjectFoundMessage } from './pre-action-messages.js';

import type { CommandScopeIndex } from '../commands/command-scope-index.js';

const MODULE_TAG = 'cli:bootstrap';

/**
 * Schema-version bailout. THROWS a {@link BootstrapError} (exit 2) with the
 * "upgrade your CLI" message when the project config declares a schema newer than
 * this CLI knows. Direction-correct: `migrate` would go the other way (old → new);
 * when the CLI itself is behind, the user must upgrade it. The top-level boundary
 * renders it (human stderr / structured `--json`); this guard no longer writes or
 * exits (§4.7).
 *
 * @throws {BootstrapError} (exit 2) when the project config's schema is newer than
 *   this CLI supports — the boundary renders the "upgrade your CLI" message.
 */
export function checkSchemaVersionAndBailout(project: ProjectContext, runId: string): void {
  if (project.scope !== 'project' || project.configPath === undefined) return;
  const configVersion = readConfigSchemaVersion(project.configPath);
  const compat = checkSchemaCompat(configVersion);
  if (compat.kind === 'cli-too-old') {
    const msg = formatCliTooOldMessage({
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
    logger.warn({
      evt: 'cli.config.schema.cli-too-old',
      module: MODULE_TAG,
      runId,
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
    throw new BootstrapError({
      message: `This project's opensip-cli.config.yml uses a newer schema (v${compat.configVersion}) than this CLI supports (v${compat.cliVersion}).`,
      humanMessage: msg,
      suggestion: 'Update your CLI: curl -fsSL https://opensip.ai/cli/install.sh | bash',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
  }
  if (compat.kind === 'older') {
    logger.info({
      evt: 'cli.config.schema.older',
      module: MODULE_TAG,
      runId,
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
  }
}

/**
 * No-project-found bailout. THROWS a {@link BootstrapError} (exit 2) for
 * project-scoped commands when discovery resolved scope === 'none'. The top-level
 * boundary renders it: human mode writes the unchanged multi-line explainer to
 * stderr; `--json` emits a structured `bootstrap.error` outcome (§4.7). The guard
 * no longer branches on json or writes a stream itself.
 *
 * @throws {BootstrapError} (exit 2) when a project-scoped command runs with no
 *   discoverable opensip-cli project (scope === 'none').
 */
export function checkNoProjectAndBailout(
  project: ProjectContext,
  cwd: string,
  commandPath: string,
  runId: string,
  commandScopes: CommandScopeIndex,
): void {
  if (project.scope !== 'none' || commandScopes.get(commandPath) === 'none') return;
  logger.warn({
    evt: 'cli.project.not-found',
    module: MODULE_TAG,
    runId,
    cwd,
    command: commandPath,
  });
  throw new BootstrapError({
    message: `No opensip-cli.config.yml found. Searched from ${cwd} upward.`,
    humanMessage: formatNoProjectFoundMessage(cwd),
    suggestion: 'Run opensip init to get started.',
    exitCode: EXIT_CODES.CONFIGURATION_ERROR,
  });
}

/**
 * Phantom-runtime warning. Detects orphaned opensip-cli/.runtime/
 * subtrees between cwd and the discovered project root — fossils from
 * pre-discovery runs that scaffolded under subdirs. Warns to stderr
 * with a safe `rm -rf` hint; never auto-deletes. Suppressed for JSON
 * output (would corrupt the stream's stderr peer in some tools).
 */
export function warnAboutPhantomRuntimes(project: ProjectContext, jsonOutput: boolean): void {
  if (jsonOutput) return;
  if (project.scope !== 'project' || project.walkedUp === 0) return;
  const phantoms = detectPhantomRuntimes(project.cwd, project.projectRoot);
  for (const phantom of phantoms) {
    process.stderr.write(
      `ℹ Detected an orphaned opensip-cli/ at:\n` +
        `    ${phantom}\n` +
        `  Left over from running opensip from this subdirectory\n` +
        `  before project-root discovery was added. Safe to delete with:\n` +
        `    rm -rf ${phantom}\n\n`,
    );
  }
}
