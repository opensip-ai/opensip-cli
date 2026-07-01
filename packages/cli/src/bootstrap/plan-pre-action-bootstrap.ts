/**
 * plan-pre-action-bootstrap — pure planner for the pre-action bootstrap
 * phases through the bailout window (ADR-0052).
 *
 * Does NOT mutate the process-wide logger, enter a scope, or open a
 * datastore. Returns a {@link PreActionBootstrapPlan} the hook (or tests)
 * pass to the post-bailout executor.
 */

import { existsSync } from 'node:fs';

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  resolveProjectContext,
  resolveProjectPaths,
  type LoggerOptions,
  type ProjectContext,
} from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';
import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';
import { PRE_ACTION_PHASES } from './pre-action-bootstrap-phases.js';
import {
  checkNoProjectAndBailout,
  checkSchemaVersionAndBailout,
  warnAboutPhantomRuntimes,
} from './pre-action-guards.js';

import type { loadCliDefaults as loadCliDefaultsFn } from './cli-defaults.js';
import type { CommandScopeIndex } from '../commands/command-scope-index.js';

export interface PlanPreActionBootstrapInput {
  readonly opts: Record<string, unknown>;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly runId: string;
  readonly commandName: string;
  readonly commandPath: string;
  readonly commandScopes: CommandScopeIndex;
  readonly explicitConfigPath?: string;
}

export interface PreActionBootstrapPlan {
  readonly runId: string;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly opts: Record<string, unknown>;
  readonly cliDefaults: ReturnType<typeof loadCliDefaultsFn>;
  readonly project: ProjectContext;
  readonly commandName: string;
  readonly commandPath: string;
  readonly jsonOutput: boolean;
  /** Per-run logger options computed after bailouts (ADR-0053). */
  readonly runLoggerOptions: LoggerOptions;
  readonly completedThrough: typeof PRE_ACTION_PHASES.bailoutWindow;
}

/**
 * Plan phases 1–4 (read options through bailout window). Throws
 * {@link BootstrapError} on config-resolve or bailout failures.
 *
 * @throws {BootstrapError} When config resolution fails or an early bootstrap
 *   guard bails out before project side effects are allowed.
 */
export function planPreActionBootstrap(input: PlanPreActionBootstrapInput): PreActionBootstrapPlan {
  const {
    opts,
    cwd,
    cwdExplicit,
    runId,
    commandName,
    commandPath,
    commandScopes,
    explicitConfigPath,
  } = input;

  const cliDefaults = loadCliDefaults(cwd, explicitConfigPath);
  mergeConfigDefaults(opts, cliDefaults);

  let project: ProjectContext;
  try {
    project = resolveProjectContext({
      cwd,
      cwdExplicit,
      explicitConfigPath,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new BootstrapError({
      message: msg,
      humanMessage: `✗ ${msg}`,
      suggestion: 'Check opensip-cli.config.yml (or your --config path).',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
  }

  opts.projectContext = project;
  opts.cwdExplicit = cwdExplicit;

  checkSchemaVersionAndBailout(project, runId);
  checkNoProjectAndBailout(project, cwd, commandPath, runId, commandScopes);
  warnAboutPhantomRuntimes(project, opts.json === true);

  const runLoggerOptions: LoggerOptions = {
    silent: true,
    debugMode: Boolean(opts.debug),
    runId,
    ...(project.scope === 'project' && existsSync(project.projectRoot)
      ? { logDir: resolveProjectPaths(project.projectRoot).logsDir }
      : {}),
  };

  return {
    runId,
    cwd,
    cwdExplicit,
    opts,
    cliDefaults,
    project,
    commandName,
    commandPath,
    jsonOutput: opts.json === true,
    runLoggerOptions,
    completedThrough: PRE_ACTION_PHASES.bailoutWindow,
  };
}
