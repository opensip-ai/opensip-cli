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

import {
  checkSchemaCompat,
  detectPhantomRuntimes,
  logger,
  readConfigSchemaVersion,
  type ProjectContext,
} from '@opensip-tools/core';

import { formatCliTooOldMessage, formatNoProjectFoundMessage } from './pre-action-messages.js';

const MODULE_TAG = 'cli:bootstrap';

/**
 * Commands that operate WITHOUT requiring a project context. These don't
 * read project files or the datastore; running them from a directory
 * with no opensip-tools project is legitimate.
 *
 * Everything else is project-scoped: when `project.scope === 'none'`,
 * the hook emits the "No opensip-tools project found" error and exits 2.
 *
 * Note: `uninstall --user` is project-agnostic, but `uninstall --project`
 * requires one. The check is per-command name here; uninstall's own
 * mode-specific guarding lives in its action body.
 */
const PROJECT_AGNOSTIC_COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'configure',
  'completion',
  'uninstall',
]);

/**
 * Schema-version bailout. Exits 2 with the "upgrade your CLI" message
 * when the project config declares a schema newer than this CLI knows.
 * Direction-correct: `migrate` would go the other way (old → new); when
 * the CLI itself is behind, the user must upgrade it.
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
    process.stderr.write(`${msg}\n`);
    logger.warn({
      evt: 'cli.config.schema.cli-too-old',
      module: MODULE_TAG,
      runId,
      root: project.projectRoot,
      configVersion: compat.configVersion,
      cliVersion: compat.cliVersion,
    });
    process.exit(2);
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
 * No-project-found bailout. Exits 2 with the actionable error message
 * for project-scoped commands when discovery resolved scope === 'none'.
 */
export function checkNoProjectAndBailout(
  project: ProjectContext,
  cwd: string,
  cmdName: string,
  jsonOutput: boolean,
  runId: string,
): void {
  if (project.scope !== 'none' || PROJECT_AGNOSTIC_COMMANDS.has(cmdName)) return;
  const msg = formatNoProjectFoundMessage(cwd, jsonOutput);
  const stream = jsonOutput ? process.stdout : process.stderr;
  stream.write(`${msg}\n`);
  logger.warn({
    evt: 'cli.project.not-found',
    module: MODULE_TAG,
    runId,
    cwd,
    command: cmdName,
  });
  process.exit(2);
}

/**
 * Phantom-runtime warning. Detects orphaned opensip-tools/.runtime/
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
      `ℹ Detected an orphaned opensip-tools/ at:\n` +
      `    ${phantom}\n` +
      `  Left over from running opensip-tools from this subdirectory\n` +
      `  before project-root discovery was added. Safe to delete with:\n` +
      `    rm -rf ${phantom}\n\n`
    );
  }
}
