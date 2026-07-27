/**
 * Leaf guards used while preparing a command's leased bootstrap plan.
 *
 * Split out of `pre-action-hook.ts` when that file passed the repository's file-length bound.
 * These five are the pure, self-contained half: they inspect an option bag, a project key or a
 * coordination identity and either return a value or refuse. Everything they need is passed in,
 * so none of the hook's lease lifecycle or Commander wiring follows them here.
 */

import {
  ConfigurationError,
  projectCoordinationKey,
  type CommandScopeRequirement,
  type RuntimeLease,
} from '@opensip-cli/core';

import { hostPolicyNeedsProjectCoordination } from '../commands/host-runtime-access.js';
import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { type planPreActionBootstrap } from './plan-pre-action-bootstrap.js';

import type { StartupRuntimeLeaseHandoff } from './startup-runtime-lease.js';

const PROJECT_REQUIRED = hostErrorCatalog.require('CLI.HOST.PROJECT_REQUIRED');

/** Repeated attempts to read a stable runtime context before refusing. */
export const MAX_RUNTIME_CONTEXT_STABILIZATION_ATTEMPTS = 3;

export function cloneParsedOptions(opts: Record<string, unknown>): Record<string, unknown> {
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
export function recoveryGuidance(error: unknown): never {
  if (error instanceof ConfigurationError && error.code === 'CORE.RUNTIME_RECOVERY.REQUIRED') {
    throw new ConfigurationError(
      `${error.message} Run 'opensip status' to inspect recovery state, then run 'opensip init' to resume or reconcile it.`,
      { code: error.code, cause: error },
    );
  }
  throw error;
}

export function unstableRuntimeContext(): ConfigurationError {
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
export function assertStartupProjectKey(
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

export function projectCoordinationChanged(input: {
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
