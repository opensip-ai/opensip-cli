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
  ConfigurationError,
  resolveProjectContext,
  resolveRuntimePathsForScope,
  type CommandScopeRequirement,
  type LoggerOptions,
  type ProjectContext,
} from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { BootstrapError } from './bootstrap-error.js';
import { loadCliDefaults, mergeConfigDefaults } from './cli-defaults.js';
import { synthesizeNoInitConfigDocument } from './no-init-config.js';
import { isNoInitEligibleCommand } from './no-init-eligibility.js';
import { PRE_ACTION_PHASES } from './pre-action-bootstrap-phases.js';
import {
  checkNoProjectAndBailout,
  checkSchemaVersionAndBailout,
  warnAboutPhantomRuntimes,
} from './pre-action-guards.js';

import type { CliDefaults } from './cli-defaults.js';
import type { CommandScopeIndex } from '../commands/command-scope-index.js';
import type { HostCommandRuntimePolicy } from '../commands/host-runtime-access.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const WIRING_INVALID = hostErrorCatalog.require('SYSTEM.HOST.WIRING_INVALID');

export type BootstrapPlanningMode = 'tentative' | 'authoritative';

export interface PlanPreActionBootstrapInput {
  readonly opts: Record<string, unknown>;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly runId: string;
  readonly commandName: string;
  readonly commandPath: string;
  readonly commandScopes: CommandScopeIndex;
  readonly explicitConfigPath?: string;
  /**
   * Tentative planning performs side-effect-free discovery only. It never
   * emits warnings, runs bailout guards, or mutates the caller's options.
   */
  readonly planningMode?: BootstrapPlanningMode;
}

export interface PreActionBootstrapPlan {
  readonly runId: string;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly opts: Record<string, unknown>;
  readonly cliDefaults: CliDefaults;
  readonly project: ProjectContext;
  readonly commandName: string;
  readonly commandPath: string;
  readonly commandScope: CommandScopeRequirement;
  readonly jsonOutput: boolean;
  readonly runtimePolicy: HostCommandRuntimePolicy;
  /** Per-run logger options computed after bailouts (ADR-0053). */
  readonly runLoggerOptions: LoggerOptions;
  readonly completedThrough:
    typeof PRE_ACTION_PHASES.resolveProject | typeof PRE_ACTION_PHASES.bailoutWindow;
}

function logDirForProject(project: ProjectContext): {
  readonly logDir?: string;
} {
  if (project.scope === 'none' || !existsSync(project.projectRoot)) return {};
  return { logDir: resolveRuntimePathsForScope(project).logsDir };
}

function shouldLoadDefaults(
  planningMode: BootstrapPlanningMode,
  runtimePolicy: HostCommandRuntimePolicy,
): boolean {
  if (planningMode !== 'authoritative') return false;
  return runtimePolicy.bootstrapMode !== 'inspection-only';
}

/**
 * Plan phases 1–4 (read options through bailout window). Throws
 * {@link BootstrapError} on config-resolve or bailout failures.
 *
 * @throws {BootstrapError} When config resolution fails or an early bootstrap
 *   guard bails out before project side effects are allowed.
 */
export function planPreActionBootstrap(input: PlanPreActionBootstrapInput): PreActionBootstrapPlan {
  const { cwd, cwdExplicit, runId, commandName, commandPath, commandScopes, explicitConfigPath } =
    input;
  const planningMode = input.planningMode ?? 'authoritative';
  const commandEntry = commandScopes.get(commandPath);
  if (commandEntry === undefined) {
    throw new ConfigurationError(
      `No declared runtime scope exists for mounted command '${commandPath}'.`,
      {
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'scope-undeclared' },
      },
    );
  }
  const runtimePolicy = commandEntry.runtimePolicy;
  const commandScope = commandEntry.scope;
  const inspectionOnly = runtimePolicy.bootstrapMode === 'inspection-only';
  const shouldLoadCliDefaults = shouldLoadDefaults(planningMode, runtimePolicy);
  // Planning may run more than once around lease acquisition. Clone arrays as
  // well as the containing record so mergeConfigDefaults cannot append into
  // Commander's live option values before the authoritative plan is stable.
  const opts = Object.fromEntries(
    Object.entries(input.opts).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map((item: unknown) => item) : value,
    ]),
  );

  // Tentative discovery and inspection-only status must not read user
  // defaults/API-key state. Ordinary authoritative commands retain the
  // established CLI-default behavior.
  const cliDefaults: CliDefaults = shouldLoadCliDefaults
    ? loadCliDefaults(cwd, explicitConfigPath)
    : {};
  if (shouldLoadCliDefaults) {
    mergeConfigDefaults(opts, cliDefaults);
  }

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

  if (
    planningMode === 'authoritative' &&
    !inspectionOnly &&
    project.scope === 'none' &&
    explicitConfigPath === undefined &&
    isNoInitEligibleCommand(commandPath, commandScopes) &&
    commandScopes.get(commandPath)?.scope === 'project'
  ) {
    const synthesized = synthesizeNoInitConfigDocument(project.projectRoot);
    if (synthesized !== undefined) {
      project = {
        ...project,
        scope: 'ephemeral',
        ephemeralConfigDocument: synthesized.document,
      };
    }
  }

  opts.projectContext = project;
  opts.cwdExplicit = cwdExplicit;

  if (planningMode === 'authoritative' && !inspectionOnly) {
    checkSchemaVersionAndBailout(project, runId);
    checkNoProjectAndBailout(project, cwd, commandPath, runId, commandScopes);
    warnAboutPhantomRuntimes(project, opts.json === true);
  }

  const runLoggerOptions: LoggerOptions = {
    silent: true,
    debugMode: Boolean(opts.debug),
    runId,
    ...(planningMode === 'authoritative' && !inspectionOnly && commandScope === 'project'
      ? logDirForProject(project)
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
    commandScope,
    jsonOutput: opts.json === true,
    runtimePolicy,
    runLoggerOptions,
    completedThrough:
      planningMode === 'tentative'
        ? PRE_ACTION_PHASES.resolveProject
        : PRE_ACTION_PHASES.bailoutWindow,
  };
}
