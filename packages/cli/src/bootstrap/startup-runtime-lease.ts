/**
 * startup-runtime-lease — protect dynamic Tool discovery before Commander has
 * mounted enough of the command surface to run the normal pre-action planner.
 *
 * Startup reads both project-local and user-global Tool roots. One composite
 * reader therefore protects bootstrap until the selected CommandSpec is known.
 * Project-scoped commands hand it into command teardown; scope-none host
 * commands release it after their exact declared resource lease is acquired.
 */

import { basename } from 'node:path';

import {
  acquireRuntimeAccessLease,
  ConfigurationError,
  projectCoordinationKey,
  resolveProjectContext,
  type FileLockEvent,
  type ProjectContext,
  type RuntimeAccessLease,
  type RuntimeLeaseEvent,
} from '@opensip-cli/core';

export interface StartupProjectSelection {
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  readonly explicitConfigPath?: string;
  readonly project: ProjectContext;
}

function invalidStartupOption(message: string): never {
  throw new ConfigurationError(message, {
    code: 'CONFIGURATION.STARTUP_OPTION_INVALID',
  });
}

function validateStartupPath(flag: '--cwd' | '--config', value: string): string {
  if (value.length === 0 || value.includes('\0')) {
    return invalidStartupOption(`${flag} requires a non-empty filesystem path.`);
  }
  return value;
}

type StartupPathArgument =
  | { readonly kind: 'stop' }
  | {
      readonly kind: 'path';
      readonly flag: '--cwd' | '--config';
      readonly value: string;
      readonly nextIndex: number;
    };

function parseStartupPathArgument(
  argv: readonly string[],
  index: number,
): StartupPathArgument | undefined {
  const argument = argv[index] ?? '';
  if (argument === '--') return { kind: 'stop' };
  const equals = argument.indexOf('=');
  const option = equals < 0 ? argument : argument.slice(0, equals);
  if (option !== '--cwd' && option !== '--config') return;
  const inline = equals < 0 ? undefined : argument.slice(equals + 1);
  const value = inline ?? argv[index + 1];
  if (value === undefined || (inline === undefined && value.startsWith('-'))) {
    invalidStartupOption(`${option} requires a filesystem path.`);
  }
  return {
    kind: 'path',
    flag: option,
    value: validateStartupPath(option, value),
    nextIndex: inline === undefined ? index + 1 : index,
  };
}

/**
 * Read only the two project-selection options needed before dynamic discovery.
 * Required-option values are consumed exactly once and `--` terminates option
 * scanning. Commander remains the authority for the complete option grammar.
 */
export function resolveStartupProjectSelection(
  argv: readonly string[],
  defaultCwd: string,
): StartupProjectSelection {
  let cwd = defaultCwd;
  let cwdExplicit = false;
  let explicitConfigPath: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const parsed = parseStartupPathArgument(argv, index);
    if (parsed?.kind === 'stop') break;
    if (parsed === undefined) {
      index += 1;
      continue;
    }
    if (parsed.flag === '--cwd') {
      cwd = parsed.value;
      cwdExplicit = true;
    } else {
      explicitConfigPath = parsed.value;
    }
    index = parsed.nextIndex + 1;
  }

  let project: ProjectContext;
  try {
    project = resolveProjectContext({
      cwd,
      cwdExplicit,
      ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(message, {
      code: 'CONFIGURATION.STARTUP_PROJECT_UNRESOLVED',
      cause: error,
    });
  }

  return {
    cwd,
    cwdExplicit,
    ...(explicitConfigPath === undefined ? {} : { explicitConfigPath }),
    project,
  };
}

export interface StartupRuntimeLeaseHandoff {
  readonly lease: RuntimeAccessLease;
  readonly selection: StartupProjectSelection;
  readonly state: () => 'startup' | 'command' | 'released';
  /** Fail closed if dynamic discovery is reached without the composite reader. */
  readonly assertDiscoveryProtected: (projectRoot: string) => void;
  /**
   * Transfer ownership after authoritative planning proves the same stable
   * project key. A mismatch makes the discovery snapshot unusable.
   */
  readonly claimForCommand: (projectRoot: string) => RuntimeAccessLease;
  /** Release only while startup still owns the discovery handle. */
  readonly releaseStartupOwned: () => void;
}

export interface AcquireStartupRuntimeLeaseInput {
  readonly argv: readonly string[];
  readonly defaultCwd: string;
  readonly command?: string;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
}

export interface AcquireStartupRuntimeLeaseDeps {
  readonly acquire?: typeof acquireRuntimeAccessLease;
}

const MAX_STARTUP_PROJECT_STABILIZATION_ATTEMPTS = 3;

function createStartupRuntimeLeaseHandoff(
  selection: StartupProjectSelection,
  lease: RuntimeAccessLease,
): StartupRuntimeLeaseHandoff {
  let state: 'startup' | 'command' | 'released' = 'startup';
  const commandLease: RuntimeAccessLease = Object.freeze({
    ...lease,
    release: (): void => {
      if (state === 'released') return;
      lease.release();
      state = 'released';
    },
  });

  return Object.freeze({
    lease,
    selection,
    state: () => state,
    assertDiscoveryProtected: (projectRoot: string): void => {
      if (
        state !== 'startup' ||
        !lease.projectRead ||
        !lease.userStateRead ||
        lease.coordinationKey !== projectCoordinationKey(selection.project.projectRoot) ||
        lease.coordinationKey !== projectCoordinationKey(projectRoot)
      ) {
        throw new ConfigurationError(
          'Dynamic Tool discovery requires a live project and user-state startup lease.',
          { code: 'CONFIGURATION.RUNTIME_STARTUP_LEASE_REQUIRED' },
        );
      }
    },
    claimForCommand: (projectRoot: string): RuntimeAccessLease => {
      if (state !== 'startup') {
        throw new ConfigurationError('The startup runtime lease was already consumed.', {
          code: 'CONFIGURATION.RUNTIME_STARTUP_LEASE_CONSUMED',
        });
      }
      if (
        lease.coordinationKey !== projectCoordinationKey(projectRoot) ||
        lease.coordinationKey !== projectCoordinationKey(selection.project.projectRoot)
      ) {
        throw new ConfigurationError(
          'The canonical OpenSIP project root changed during startup. Retry after concurrent Init or project movement completes.',
          { code: 'CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE' },
        );
      }
      state = 'command';
      return commandLease;
    },
    releaseStartupOwned: (): void => {
      if (state !== 'startup') return;
      lease.release();
      state = 'released';
    },
  });
}

interface StartupRuntimeLeaseAttempt {
  readonly input: AcquireStartupRuntimeLeaseInput;
  readonly acquire: typeof acquireRuntimeAccessLease;
  readonly selection: StartupProjectSelection;
  readonly attempt: number;
}

/**
 * Acquire the project+user discovery footprint. `inheritFromParent` lets an
 * internal CLI child register at its live parent's earlier reader sequence,
 * preventing a writer queued between parent and child from deadlocking them.
 *
 * @throws {ConfigurationError} When project selection is invalid or the canonical
 * project root cannot be stabilized within the bounded attempt count.
 * @throws {Error} When the runtime-access lease cannot be acquired.
 */
async function acquireStabilizedStartupRuntimeLease(
  state: StartupRuntimeLeaseAttempt,
): Promise<StartupRuntimeLeaseHandoff> {
  if (state.attempt >= MAX_STARTUP_PROJECT_STABILIZATION_ATTEMPTS) {
    throw new ConfigurationError(
      'The canonical OpenSIP project root changed repeatedly during startup. Stop concurrent project moves or Init operations and retry.',
      { code: 'CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE' },
    );
  }

  const { input, acquire, selection } = state;
  const lease = await acquire({
    projectRead: { projectDir: selection.project.projectRoot },
    userStateRead: true,
    inheritFromParent: true,
    command: input.command ?? 'opensip-startup',
    cwdBasename: basename(selection.cwd),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  });

  let stabilized: StartupProjectSelection;
  try {
    stabilized = resolveStartupProjectSelection(input.argv, input.defaultCwd);
    if (
      lease.coordinationKey === projectCoordinationKey(selection.project.projectRoot) &&
      lease.coordinationKey === projectCoordinationKey(stabilized.project.projectRoot)
    ) {
      return createStartupRuntimeLeaseHandoff(stabilized, lease);
    }
  } catch (error) {
    lease.release();
    throw error;
  }

  lease.release();
  return acquireStabilizedStartupRuntimeLease({
    input,
    acquire,
    selection: stabilized,
    attempt: state.attempt + 1,
  });
}

export async function acquireStartupRuntimeLease(
  input: AcquireStartupRuntimeLeaseInput,
  deps: AcquireStartupRuntimeLeaseDeps = {},
): Promise<StartupRuntimeLeaseHandoff> {
  return acquireStabilizedStartupRuntimeLease({
    input,
    acquire: deps.acquire ?? acquireRuntimeAccessLease,
    selection: resolveStartupProjectSelection(input.argv, input.defaultCwd),
    attempt: 0,
  });
}
