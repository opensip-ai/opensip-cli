/**
 * pre-action-hook — Commander `preAction` adapter (ADR-0052).
 *
 * Business rules live in {@link planPreActionBootstrap} (phases 1–4) and
 * {@link executePostBailoutBootstrap} (phases 5–9). This module wires those
 * to Commander's preAction/postAction hooks.
 */

import {
  ConfigurationError,
  currentScope,
  exitScope,
  generatePrefixedId,
  projectCoordinationKey,
  runWithScope,
  runWithScopeSync,
  SystemError,
  type CommandScopeRequirement,
  type RunScope,
  type RuntimeLease,
} from '@opensip-cli/core';

import { commandPath } from '../commands/command-scope-index.js';
import {
  acquireHostRuntimeLease,
  createRuntimeLeaseLifecycle,
  createSafeRuntimeLeaseEventBuffer,
  hostPolicyNeedsProjectCoordination,
  type RuntimeLeaseLifecycle,
  type SafeRuntimeLeaseEventBuffer,
} from '../commands/host-runtime-access.js';
import { hostEnv } from '../env/host-env-specs.js';
import { hostErrorCatalog } from '../errors/host-error-catalog.js';
import { setResolvedCommandLabel } from '../telemetry/command-label.js';

import { executePostBailoutBootstrap } from './execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from './plan-pre-action-bootstrap.js';

import type { CommandActionScopeRunner } from './command-action-scope-runner.js';
import type { PreActionRuntime } from './pre-action-runtime.js';
import type { StartupRuntimeLeaseHandoff } from './startup-runtime-lease.js';
import type { CommandScopeIndex } from '../commands/command-scope-index.js';
import type { Command } from 'commander';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const PROJECT_REQUIRED = hostErrorCatalog.require('CONFIGURATION.HOST.PROJECT_REQUIRED');
const WIRING_INVALID = hostErrorCatalog.require('SYSTEM.HOST.WIRING_INVALID');

export { resolveOwningTool } from './owning-tool-init.js';
export type { PreActionRuntime } from './pre-action-runtime.js';

const MAX_RUNTIME_CONTEXT_STABILIZATION_ATTEMPTS = 3;

/**
 * Per-program bridge from async pre-action bootstrap into Commander's already
 * registered action continuation. It owns no readable run state surface: its
 * only operation binds the staged RunScope for the dynamic extent of one
 * mounted action and disposes it before that extent ends.
 */
interface CommandActionScopeController extends CommandActionScopeRunner {
  readonly stage: (scope: RunScope) => void;
}

/**
 * Create one invocation-local scope handoff. This is deliberately a closure
 * returned to the composition root, never module-global mutable state.
 */
export function createCommandActionScopeRunner(): CommandActionScopeController {
  let stagedScope: RunScope | undefined;
  let activeScope: RunScope | undefined;
  return Object.freeze({
    stage: (scope: RunScope): void => {
      if (stagedScope !== undefined || activeScope !== undefined) {
        throw new SystemError('A command scope is already staged for dispatch.', {
          code: WIRING_INVALID.code,
          definition: WIRING_INVALID,
          metadata: { condition: 'scope-reentrant' },
        });
      }
      stagedScope = scope;
    },
    run: <T>(action: () => Promise<T>): Promise<T> => {
      const scope = stagedScope;
      if (scope === undefined) {
        throw new SystemError(
          'Command action started before pre-action bootstrap staged its scope.',
          {
            code: 'SYSTEM.SCOPE.NOT_ENTERED',
          },
        );
      }
      stagedScope = undefined;
      activeScope = scope;
      // Keep lifecycle ownership after the action settles. Commander postAction
      // disposes the normal path; the composition-root finally disposes rejected
      // actions only after parse-error presentation has completed.
      return runWithScope(scope, action);
    },
    runWithOwnedScope: <T>(continuation: () => Promise<T>): Promise<T> => {
      const scope = activeScope ?? stagedScope;
      return scope === undefined ? continuation() : runWithScope(scope, continuation);
    },
    disposeStaged: (): void => {
      const scope = stagedScope ?? activeScope;
      stagedScope = undefined;
      activeScope = undefined;
      if (scope !== undefined) {
        runWithScopeSync(scope, () => scope.dispose());
      }
    },
  });
}

export interface PrepareLeasedBootstrapPlanInput {
  readonly opts: Record<string, unknown>;
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly runId: string;
  readonly commandName: string;
  readonly commandPath: string;
  readonly commandScopes: CommandScopeIndex;
  readonly explicitConfigPath?: string;
  /** Composite reader held continuously across dynamic startup discovery. */
  readonly startupRuntimeLease?: StartupRuntimeLeaseHandoff;
  readonly startupLeaseEvents?: SafeRuntimeLeaseEventBuffer;
}

export interface PrepareLeasedBootstrapPlanDeps {
  readonly plan?: typeof planPreActionBootstrap;
  readonly acquire?: typeof acquireHostRuntimeLease;
}

export interface PreparedLeasedBootstrapPlan {
  readonly plan: ReturnType<typeof planPreActionBootstrap>;
  readonly runtimeLeaseLifecycle: RuntimeLeaseLifecycle;
  readonly leaseEvents: SafeRuntimeLeaseEventBuffer;
}

function cloneParsedOptions(opts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(opts).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map((item: unknown) => item) : value,
    ]),
  );
}

/**
 * Rewrap a recovery-required bootstrap failure with actionable guidance, or
 * propagate any other error unchanged.
 *
 * @throws {ConfigurationError} When `error` is a `ConfigurationError` whose
 *   code is `CONFIGURATION.RECOVERY_REQUIRED` — rethrown with `opensip
 *   status`/`opensip init` guidance appended to the message.
 * @throws {unknown} Rethrows `error` as-is for every other error.
 */
function recoveryGuidance(error: unknown): never {
  if (error instanceof ConfigurationError && error.code === 'CORE.RUNTIME_RECOVERY.REQUIRED') {
    throw new ConfigurationError(
      `${error.message} Run 'opensip status' to inspect recovery state, then run 'opensip init' to resume or reconcile it.`,
      { code: error.code, cause: error },
    );
  }
  throw error;
}

function unstableRuntimeContext(): ConfigurationError {
  return new ConfigurationError(
    'The canonical OpenSIP project root changed during startup. Retry after concurrent Init or project movement completes.',
    {
      code: PROJECT_REQUIRED.code,
      definition: PROJECT_REQUIRED,
      metadata: { condition: 'context-unstable' },
    },
  );
}

/**
 * Verify a startup-held lease's coordination key still matches the
 * (re-)discovered project root.
 *
 * @throws {ConfigurationError} When `startup` is defined and its lease's
 *   coordination key no longer matches `projectCoordinationKey(projectRoot)`
 *   (code `CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE`).
 */
function assertStartupProjectKey(
  startup: StartupRuntimeLeaseHandoff | undefined,
  projectRoot: string,
): void {
  if (
    startup !== undefined &&
    startup.lease.coordinationKey !== projectCoordinationKey(projectRoot)
  ) {
    throw unstableRuntimeContext();
  }
}

function projectCoordinationChanged(input: {
  readonly held: RuntimeLease | undefined;
  readonly declaredScope: CommandScopeRequirement;
  readonly runtimePolicy: ReturnType<typeof planPreActionBootstrap>['runtimePolicy'];
  readonly tentativeRoot: string;
  readonly authoritativeRoot: string;
}): boolean {
  return (
    input.held !== undefined &&
    hostPolicyNeedsProjectCoordination(input.declaredScope, input.runtimePolicy) &&
    projectCoordinationKey(input.tentativeRoot) !== projectCoordinationKey(input.authoritativeRoot)
  );
}

function declaredScopeForCommand(input: PrepareLeasedBootstrapPlanInput): CommandScopeRequirement {
  const commandEntry = input.commandScopes.get(input.commandPath);
  if (commandEntry === undefined) {
    throw new ConfigurationError(
      `No declared runtime scope exists for mounted command '${input.commandPath}'.`,
      {
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'scope-undeclared' },
      },
    );
  }
  return commandEntry.scope;
}

function handOffStartupLease(
  input: PrepareLeasedBootstrapPlanInput,
  declaredScope: CommandScopeRequirement,
  projectRoot: string,
): RuntimeLease | undefined {
  if (declaredScope !== 'none') {
    return input.startupRuntimeLease?.claimForCommand(projectRoot);
  }

  // Mutable Tool discovery needed the startup composite, but ordinary
  // scope-none host actions must not retain a project reader: Init and
  // uninstall acquire exclusive authority in their own bounded action
  // phases. Any explicit command resource remains represented by `held`.
  input.startupRuntimeLease?.assertDiscoveryProtected(projectRoot);
  input.startupRuntimeLease?.releaseStartupOwned();
  return undefined;
}

/**
 * Discover tentatively, acquire the declared runtime footprint, then replan
 * authoritatively while the lease is held. Repeated canonical-root churn is
 * bounded and visible.
 *
 * @throws {ConfigurationError} When no declared runtime scope exists for the
 *   mounted command (`CONFIGURATION.COMMAND_SCOPE_UNDECLARED`, via {@link
 *   declaredScopeForCommand}); when the canonical project root changes
 *   repeatedly across all stabilization attempts
 *   (`CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE`); or when planning/lease
 *   acquisition fails and {@link recoveryGuidance} rethrows a
 *   `CONFIGURATION.RECOVERY_REQUIRED` error with resume/reconcile guidance
 *   appended.
 * @throws {unknown} Rethrows, via {@link recoveryGuidance}, any other error
 *   raised by `deps.plan` or `deps.acquire` unchanged.
 */
export async function prepareLeasedBootstrapPlan(
  input: PrepareLeasedBootstrapPlanInput,
  deps: PrepareLeasedBootstrapPlanDeps = {},
): Promise<PreparedLeasedBootstrapPlan> {
  const plan = deps.plan ?? planPreActionBootstrap;
  const acquire = deps.acquire ?? acquireHostRuntimeLease;
  const pristineOpts = cloneParsedOptions(input.opts);
  const leaseEvents = input.startupLeaseEvents ?? createSafeRuntimeLeaseEventBuffer();
  let ownerToken = input.startupRuntimeLease?.lease.ownerToken;
  const declaredScope = declaredScopeForCommand(input);

  for (let attempt = 0; attempt < MAX_RUNTIME_CONTEXT_STABILIZATION_ATTEMPTS; attempt += 1) {
    let held: RuntimeLease | undefined;
    try {
      const tentative = plan({
        ...input,
        opts: cloneParsedOptions(pristineOpts),
        planningMode: 'tentative',
      });
      assertStartupProjectKey(input.startupRuntimeLease, tentative.project.projectRoot);
      held = await acquire({
        command: input.commandPath,
        cwd: input.cwd,
        projectDir: tentative.project.projectRoot,
        scope: declaredScope,
        policy: tentative.runtimePolicy,
        ...(ownerToken === undefined ? {} : { ownerToken }),
        onEvent: leaseEvents.onEvent,
      });
      ownerToken = held?.ownerToken ?? ownerToken;

      const authoritative = plan({
        ...input,
        opts: cloneParsedOptions(pristineOpts),
        planningMode: 'authoritative',
      });
      if (
        projectCoordinationChanged({
          held,
          declaredScope,
          runtimePolicy: authoritative.runtimePolicy,
          tentativeRoot: tentative.project.projectRoot,
          authoritativeRoot: authoritative.project.projectRoot,
        })
      ) {
        held?.release();
        held = undefined;
        if (input.startupRuntimeLease !== undefined) {
          throw unstableRuntimeContext();
        }
        continue;
      }

      const startupLease = handOffStartupLease(
        input,
        declaredScope,
        authoritative.project.projectRoot,
      );
      return {
        plan: authoritative,
        runtimeLeaseLifecycle: createRuntimeLeaseLifecycle(
          held,
          startupLease === undefined ? [] : [startupLease],
        ),
        leaseEvents,
      };
    } catch (error) {
      held?.release();
      recoveryGuidance(error);
    }
  }

  throw new ConfigurationError(
    'The canonical OpenSIP project root changed repeatedly during startup. Stop concurrent project moves or Init operations and retry.',
    {
      code: PROJECT_REQUIRED.code,
      definition: PROJECT_REQUIRED,
      metadata: { condition: 'context-unstable' },
    },
  );
}

export function installPreActionHook(
  program: Command,
  version: string,
  runtime: PreActionRuntime,
  commandScopes: CommandScopeIndex,
  startupRuntimeLease?: StartupRuntimeLeaseHandoff,
  startupLeaseEvents?: SafeRuntimeLeaseEventBuffer,
): CommandActionScopeRunner {
  const actionScope = createCommandActionScopeRunner();
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // M12: stamp the RESOLVED command name for the duration metric's label
    // (bounded cardinality) before any bootstrap that might throw — set as early
    // as the matched command is known.
    setResolvedCommandLabel(actionCommand.name());
    // B1 ("Child runId behavior"): resolve `runId` env-FIRST. A forked/spawned
    // child re-enters this hook and inherits its parent's run via `OPENSIP_RUN_ID`
    // (set in the child env by `correlationToEnv`); a top-level invocation, with
    // no `OPENSIP_RUN_ID` set, mints a fresh id. This is the single inheritance
    // seam — the spec JSON deliberately never carries `runId`, because the logger
    // that stamps every worker line is already live before the spec is parsed.
    const inherited = hostEnv.get<string>('OPENSIP_RUN_ID');
    const runId = inherited && inherited.length > 0 ? inherited : generatePrefixedId('run');
    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

    const prepared = await prepareLeasedBootstrapPlan({
      opts: opts,
      cwd,
      cwdExplicit,
      runId,
      commandName: actionCommand.name(),
      commandPath: commandPath(actionCommand),
      commandScopes,
      explicitConfigPath: opts.config as string | undefined,
      ...(startupRuntimeLease === undefined ? {} : { startupRuntimeLease }),
      ...(startupLeaseEvents === undefined ? {} : { startupLeaseEvents }),
    });

    let completedScope: RunScope | undefined;
    try {
      // Commander handlers read the live options object. Publish only the final
      // authoritative values after stabilization, never tentative defaults.
      // Publication belongs inside the lease-owned failure boundary.
      Object.assign(opts, prepared.plan.opts);
      const { scope } = await executePostBailoutBootstrap({
        plan: prepared.plan,
        runtime,
        version,
        noCloud: actionCommand.optsWithGlobals().cloud === false,
        apiKey: prepared.plan.opts.apiKey as string | undefined,
        runtimeLeaseLifecycle: prepared.runtimeLeaseLifecycle,
        leaseEvents: prepared.leaseEvents,
      });
      completedScope = scope;
      scope.diagnostics.event(
        'load',
        'debug',
        `preAction bootstrap completed for '${actionCommand.name()}'`,
      );
      actionScope.stage(scope);
    } catch (error) {
      const failedScope = completedScope;
      if (failedScope !== undefined) {
        runWithScopeSync(failedScope, () => failedScope.dispose());
      }
      prepared.runtimeLeaseLifecycle.releaseBootstrapOwned();
      throw error;
    } finally {
      // `enterScope` happened after an async lease wait, so its ALS binding is
      // local to this pre-action continuation and cannot reach Commander's
      // already-created action continuation. Clear it here; the central mount
      // plane rebinds the exact scope through actionScope.run().
      if (completedScope !== undefined && currentScope() === completedScope) {
        exitScope();
      }
    }
  });

  program.hook('postAction', () => {
    actionScope.disposeStaged();
    disposeCurrentScope();
  });
  return actionScope;
}

export function disposeCurrentScope(): void {
  try {
    const s = currentScope();
    if (s && typeof s.dispose === 'function') {
      s.dispose();
    }
  } catch {
    // @swallow-ok dispose errors on shutdown; the run has already produced its outcome.
  } finally {
    // Complete the per-command lifecycle: clear the ambient ALS slot so a
    // subsequent command in the same process (a long-lived host driving
    // Commander sequentially) starts with a clean slot and its `enterScope`
    // does not trip the always-on re-entrancy guard against this finished run.
    // Production runs one command per process, so this is normally the final
    // teardown; it is a no-op when no scope is current.
    exitScope();
  }
}
