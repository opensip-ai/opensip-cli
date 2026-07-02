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
import { shouldRenderNoInitAdoptionHint } from './no-init-eligibility.js';
import { maybeInitializeOwningTool, resolveOwningTool } from './owning-tool-init.js';
import { PRE_ACTION_PHASES } from './pre-action-bootstrap-phases.js';
import {
  isDedicatedBootstrapDiagnosticCommand,
  renderRelevantBootstrapDiagnostics,
} from './render-bootstrap-diagnostics.js';
import { createStartupTimer, type StartupTimingEvent } from './startup-timing.js';

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
  readonly isScopeEntered?: () => boolean;
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
    | 'isScopeEntered'
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
  isScopeEntered: () => currentScope() !== undefined,
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
  const { languages, tools, manifests, provenance, bootstrapDiagnostics } = runtime;
  const preActionTimer = createStartupTimer();
  let emittedTimingCount = 0;
  const emitNewTimings = (scope: RunScope): void => {
    const events = preActionTimer.events();
    emitPreActionTimingEvents(scope, events.slice(emittedTimingCount));
    emittedTimingCount = events.length;
  };

  record(PRE_ACTION_PHASES.projectSideEffects);

  const { runLogger, update } = preActionTimer.measure(PRE_ACTION_PHASES.projectSideEffects, () => {
    const createdRunLogger = d.createRunLogger(plan.runLoggerOptions);
    const checkedUpdate = preActionTimer.measure('update-check', () =>
      d.checkForUpdate({ name: CLI_PACKAGE_NAME, version }),
    );
    if (checkedUpdate && plan.jsonOutput) {
      process.stderr.write(formatUpdateNag(version, checkedUpdate));
    }
    return { runLogger: createdRunLogger, update: checkedUpdate };
  });

  record(PRE_ACTION_PHASES.buildScope);

  // B2 / GAP e: parentCommand is the FIRST segment of the invoked command path
  // (e.g. `graph`, `fit`) — NOT a child's own `graph-shard-worker`. toolName is
  // the owning tool id of the dispatched command (resolved by the same
  // owning-tool resolution the preflight uses); fall back to parentCommand when
  // the command belongs to no tool (CLI-only commands have a 1:1 name).
  const parentCommand = plan.commandPath.split(' ')[0] ?? plan.commandName;
  const { owningTool, scope } = preActionTimer.measure(PRE_ACTION_PHASES.buildScope, () => {
    const resolvedOwningTool = d.resolveOwningTool(tools, plan.commandPath);
    const toolName = resolvedOwningTool?.metadata.id ?? parentCommand;
    return {
      owningTool: resolvedOwningTool,
      scope: d.buildPerRunScope({
        project: plan.project,
        runId: plan.runId,
        cwd: plan.cwd,
        parentCommand,
        toolName,
        cliDefaults: plan.cliDefaults,
        registries: { languages, tools },
        manifests,
        provenance,
        bootstrapDiagnostics,
        startupTimings: runtime.startupTimings,
        apiKey,
        noCloud,
        logger: runLogger,
        ui: { version, update },
      }),
    };
  });
  const toolName = owningTool?.metadata.id ?? parentCommand;

  record(PRE_ACTION_PHASES.enterScope);
  preActionTimer.measure(PRE_ACTION_PHASES.enterScope, () => {
    if (shouldRenderNoInitAdoptionHint({ project: plan.project, opts: plan.opts })) {
      scope.bootstrapDiagnostics.record({
        severity: 'warning',
        code: 'OPENSIP_NO_INIT_EPHEMERAL_PROJECT',
        category: 'configuration',
        message: 'Running with auto-detected no-init configuration.',
        impact:
          'Project-local plugins, custom recipes, and committed baselines are unavailable until the project is initialized.',
        action: "Run 'opensip init' to save this configuration and track baselines across runs.",
        provenance: { toolId: toolName },
      });
    }

    d.enterScope(scope); // resilience-ok: Commander postAction in pre-action-hook.ts disposes the entered RunScope after the action completes.

    if (
      !isDedicatedBootstrapDiagnosticCommand(plan.commandPath) &&
      plan.jsonOutput !== true &&
      plan.opts.help !== true
    ) {
      renderRelevantBootstrapDiagnostics(scope.bootstrapDiagnostics, toolName);
    }

    if (!d.isScopeEntered()) {
      throw new SystemError('Scope was not entered before command dispatch', {
        code: 'SYSTEM.SCOPE.NOT_ENTERED',
      });
    }
  });
  emitNewTimings(scope);

  record(PRE_ACTION_PHASES.hostStartEffects);

  preActionTimer.measure(PRE_ACTION_PHASES.hostStartEffects, () => {
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
  });
  emitNewTimings(scope);

  record(PRE_ACTION_PHASES.toolPreflight);

  await preActionTimer.measureAsync(PRE_ACTION_PHASES.toolPreflight, async () => {
    // ADR-0054 M4-F: pass provenance so an EXTERNAL owning tool's initialize is
    // skipped in-host (it runs worker-side under dispatch); bundled runs in-host.
    await preActionTimer.measureAsync('owning-tool-initialize', () =>
      d.maybeInitializeOwningTool(tools, plan.commandPath, plan.runId, provenance),
    );

    const driven = await preActionTimer.measureAsync('owning-capability-load', () =>
      d.loadOwningToolCapabilities({
        owningTool,
        projectDir: plan.project.projectRoot,
        pluginsConfig: scope.configDocument?.plugins ?? {},
      }),
    );
    if (driven > 0) {
      scope.diagnostics.event(
        'load',
        'debug',
        `drove ${String(driven)} owning-tool capability domain(s) (see per-domain 'capability ... loaded' events for contribution counts + errors)`,
      );
      scope.diagnostics.counter('capabilities.driven', driven);
    }
  });
  emitNewTimings(scope);

  return { scope, runLogger };
}

function emitPreActionTimingEvents(scope: RunScope, timings: readonly StartupTimingEvent[]): void {
  for (const timing of timings) {
    scope.diagnostics.event('load', 'debug', `pre-action phase '${timing.name}' completed`, {
      source: 'pre-action',
      phase: timing.name,
      durationMs: timing.durationMs,
      sinceStartMs: timing.sinceStartMs,
      ...(timing.skipped === true ? { skipped: true } : {}),
    });
  }
}
