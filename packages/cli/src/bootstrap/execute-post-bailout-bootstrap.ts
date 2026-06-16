/**
 * execute-post-bailout-bootstrap — post-bailout phases 5–9 (ADR-0052).
 *
 * Side effects after the bailout window: per-run logger, scope build/enter,
 * host start effects, and tool preflight. Injectable deps support table-driven
 * phase-order tests without Commander.
 */

import {
  createRunLogger,
  currentScope,
  enterScope,
  getMeter,
  SystemError,
  type Logger,
  type RunScope,
} from '@opensip-cli/core';

import { startProfiling } from '../telemetry/profiling.js';
import { checkForUpdate, formatUpdateNag } from '../update-notifier.js';

import { buildPerRunScope } from './build-per-run-scope.js';
import { loadOwningToolCapabilities } from './load-tool-capabilities.js';
import { maybeInitializeOwningTool, resolveOwningTool } from './owning-tool-init.js';
import { PRE_ACTION_PHASES } from './pre-action-bootstrap-phases.js';

import type { PreActionBootstrapPlan } from './plan-pre-action-bootstrap.js';
import type { PreActionRuntime } from './pre-action-runtime.js';

const MODULE_TAG = 'cli:bootstrap';
const CLI_PACKAGE_NAME = 'opensip-cli';

function noopPhaseRecord(): void {
  // Default when callers omit recordPhase (production hook path).
}

/** Recorded phase transitions for ordering tests. */
export type PhaseRecorder = (phase: string) => void;

export interface PostBailoutBootstrapInput {
  readonly plan: PreActionBootstrapPlan;
  readonly runtime: PreActionRuntime;
  readonly version: string;
  readonly noCloud: boolean;
  readonly apiKey?: string;
}

export interface PostBailoutBootstrapDeps {
  readonly recordPhase?: PhaseRecorder;
  readonly createRunLogger?: typeof createRunLogger;
  readonly buildPerRunScope?: typeof buildPerRunScope;
  readonly enterScope?: typeof enterScope;
  readonly checkForUpdate?: typeof checkForUpdate;
  readonly startProfiling?: typeof startProfiling;
  readonly maybeInitializeOwningTool?: typeof maybeInitializeOwningTool;
  readonly loadOwningToolCapabilities?: typeof loadOwningToolCapabilities;
  readonly resolveOwningTool?: typeof resolveOwningTool;
}

export interface PostBailoutBootstrapResult {
  readonly scope: RunScope;
  readonly runLogger: Logger;
}

const defaultDeps: Required<
  Pick<
    PostBailoutBootstrapDeps,
    | 'createRunLogger'
    | 'buildPerRunScope'
    | 'enterScope'
    | 'checkForUpdate'
    | 'startProfiling'
    | 'maybeInitializeOwningTool'
    | 'loadOwningToolCapabilities'
    | 'resolveOwningTool'
  >
> = {
  createRunLogger,
  buildPerRunScope,
  enterScope,
  checkForUpdate,
  startProfiling,
  maybeInitializeOwningTool,
  loadOwningToolCapabilities,
  resolveOwningTool,
};

/**
 * Run post-bailout bootstrap phases. Returns the entered scope and its
 * per-run logger (ADR-0053).
 */
export async function executePostBailoutBootstrap(
  input: PostBailoutBootstrapInput,
  deps: PostBailoutBootstrapDeps = {},
): Promise<PostBailoutBootstrapResult> {
  const d = { ...defaultDeps, ...deps };
  const record = deps.recordPhase ?? noopPhaseRecord;
  const { plan, runtime, version, noCloud, apiKey } = input;
  const { languages, tools, manifests, provenance } = runtime;

  record(PRE_ACTION_PHASES.projectSideEffects);

  const runLogger = d.createRunLogger(plan.runLoggerOptions);

  const bannerSize = plan.cliDefaults.ui?.banner ?? 'mini';
  const update = d.checkForUpdate({ name: CLI_PACKAGE_NAME, version });
  if (update && (bannerSize !== 'mini' || plan.jsonOutput)) {
    process.stderr.write(formatUpdateNag(version, update));
  }

  record(PRE_ACTION_PHASES.buildScope);

  const scope = d.buildPerRunScope({
    project: plan.project,
    runId: plan.runId,
    cwd: plan.cwd,
    cliDefaults: plan.cliDefaults,
    registries: { languages, tools },
    manifests,
    provenance,
    apiKey,
    noCloud,
    logger: runLogger,
    ui: { version, update },
  });

  record(PRE_ACTION_PHASES.enterScope);
  d.enterScope(scope);

  if (!currentScope()) {
    throw new SystemError('Scope was not entered before command dispatch', {
      code: 'SYSTEM.SCOPE.NOT_ENTERED',
    });
  }

  record(PRE_ACTION_PHASES.hostStartEffects);

  scope.diagnostics.event('load', 'debug', `${tools.list().length} tool(s) loaded`);
  scope.diagnostics.counter('tools.loaded', tools.list().length);

  getMeter('opensip-cli').createCounter('opensip_cli.commands.started').add(1, {
    command: plan.commandName,
  });
  scope.diagnostics.event(
    'validate',
    'debug',
    `project config resolved (scope: ${plan.project.scope})`,
  );

  runLogger.info({
    evt: 'cli.run.start',
    module: MODULE_TAG,
    runId: plan.runId,
    command: plan.commandName,
    cwd: plan.cwd,
    projectRoot: plan.project.projectRoot,
    scope: plan.project.scope,
  });

  if (plan.project.walkedUp > 0) {
    runLogger.info({
      evt: 'cli.project.discovered',
      module: MODULE_TAG,
      runId: plan.runId,
      cwd: plan.cwd,
      projectRoot: plan.project.projectRoot,
      walkedUp: plan.project.walkedUp,
    });
  }

  d.startProfiling(scope, plan.commandName);

  record(PRE_ACTION_PHASES.toolPreflight);

  await d.maybeInitializeOwningTool(tools, plan.commandName, plan.runId);

  const driven = await d.loadOwningToolCapabilities({
    owningTool: d.resolveOwningTool(tools, plan.commandName),
    projectDir: plan.project.projectRoot,
    configPath: plan.project.scope === 'project' ? plan.project.configPath : undefined,
  });
  if (driven > 0) {
    scope.diagnostics.event(
      'load',
      'debug',
      `drove ${String(driven)} owning-tool capability domain(s) (see per-domain 'capability ... loaded' events for contribution counts + errors)`,
    );
    scope.diagnostics.counter('capabilities.driven', driven);
  }

  return { scope, runLogger };
}
