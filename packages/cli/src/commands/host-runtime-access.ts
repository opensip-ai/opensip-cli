/**
 * CLI-owned runtime access declarations and lease acquisition.
 *
 * These facts deliberately decorate host CommandSpecs only after core has
 * validated/frozen the public command contract. Tool CommandSpecs never flow
 * through this module, so third-party tools cannot request host bootstrap
 * privileges or inspection-only startup.
 */

import { basename } from 'node:path';

import {
  acquireRuntimeAccessLease,
  acquireRuntimeReadLease,
  acquireUserStateReadLease,
  coreErrorCatalog,
  SystemError,
  type CommandScopeRequirement,
  type FileLockEvent,
  type RuntimeLease,
  type RuntimeLeaseEvent,
} from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import type { HostCommandRuntimePolicy } from './host-runtime-policy.js';
import type { DatastoreCloseResult } from '@opensip-cli/datastore';

/** Core owns the SYSTEM.RUNTIME_LEASE.* namespace, so this definition comes from core. */
const LEASE_RELEASE_FAILED = coreErrorCatalog.require('SYSTEM.RUNTIME_LEASE.RELEASE_FAILED');

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const WIRING_INVALID = hostErrorCatalog.require('SYSTEM.HOST.WIRING_INVALID');

export {
  DEFAULT_HOST_RUNTIME_POLICY,
  defineHostCommand,
  hostPolicyNeedsProjectCoordination,
  isInspectionOnlyHostRequest,
  resolveHostRuntimePolicy,
  resolveHostRuntimePolicyForScope,
} from './host-runtime-policy.js';
export type {
  HostBootstrapMode,
  HostCommandRuntimePolicy,
  HostRuntimeAccess,
  HostRuntimeCommandSpec,
} from './host-runtime-policy.js';

const INSPECTION_ONLY = 'inspection-only' as const;

/**
 * Bounded event projection safe for CLI diagnostics. Raw paths, host identity,
 * PIDs, metadata, and owner tokens are discarded synchronously at callback
 * time; callers never retain the core event object.
 */
export interface SafeRuntimeLeaseEvent {
  readonly kind: RuntimeLeaseEvent['kind'] | FileLockEvent['kind'];
  readonly resource: 'runtime';
  readonly operation?: string;
  readonly waitMs?: number;
}

export interface SafeRuntimeLeaseEventSink {
  readonly onEvent: (event: SafeRuntimeLeaseEvent) => void;
  readonly onDropped: (count: number) => void;
}

export interface SafeRuntimeLeaseEventBuffer {
  readonly onEvent: (event: RuntimeLeaseEvent | FileLockEvent) => void;
  /**
   * Flush buffered projections and synchronously forward later projections.
   * Sink failures are diagnostic-only and never escape into lease mechanics.
   */
  readonly attach: (sink: SafeRuntimeLeaseEventSink) => void;
  readonly drain: () => {
    readonly events: readonly SafeRuntimeLeaseEvent[];
    readonly dropped: number;
  };
}

const MAX_SAFE_LEASE_EVENTS = 64;
const SAFE_RUNTIME_OPERATIONS = new Set([
  'runtime-read',
  'runtime-exclusive',
  'runtime-access-composite',
  'user-state-read',
  'runtime-global-maintenance',
  'coordination-transition',
  'ephemeral-marker',
  'ephemeral-prune-stamp',
  'create',
  'replace',
  'unlink',
]);

function boundedOperation(operation: string | undefined): string | undefined {
  return operation !== undefined && SAFE_RUNTIME_OPERATIONS.has(operation) ? operation : undefined;
}

/** Create a one-shot bounded lease-event buffer. */
export function createSafeRuntimeLeaseEventBuffer(
  limit = MAX_SAFE_LEASE_EVENTS,
): SafeRuntimeLeaseEventBuffer {
  const cap = Math.max(0, Math.min(MAX_SAFE_LEASE_EVENTS, Math.floor(limit)));
  const events: SafeRuntimeLeaseEvent[] = [];
  let dropped = 0;
  let attached = false;
  let attachedSink: SafeRuntimeLeaseEventSink | undefined;
  const deliver = (event: SafeRuntimeLeaseEvent): void => {
    try {
      attachedSink?.onEvent(event);
    } catch {
      try {
        attachedSink?.onDropped(1);
      } catch {
        // @swallow-ok diagnostic observers cannot invalidate lease mechanics.
      }
    }
  };
  return Object.freeze({
    onEvent: (event: RuntimeLeaseEvent | FileLockEvent): void => {
      const projected: SafeRuntimeLeaseEvent = Object.freeze({
        kind: event.kind,
        resource: 'runtime',
        ...(boundedOperation(event.operation) === undefined
          ? {}
          : { operation: boundedOperation(event.operation) }),
        ...(typeof event.waitMs === 'number' && Number.isFinite(event.waitMs)
          ? { waitMs: Math.max(0, Math.floor(event.waitMs)) }
          : {}),
      });
      if (attached) {
        deliver(projected);
        return;
      }
      if (events.length >= cap) {
        dropped += 1;
        return;
      }
      events.push(projected);
    },
    attach: (sink: SafeRuntimeLeaseEventSink): void => {
      if (attached) return;
      attached = true;
      attachedSink = sink;
      const pending = events.splice(0);
      const pendingDropped = dropped;
      dropped = 0;
      for (const event of pending) deliver(event);
      if (pendingDropped > 0) {
        try {
          sink.onDropped(pendingDropped);
        } catch {
          // @swallow-ok diagnostic observers cannot invalidate lease mechanics.
        }
      }
    },
    drain: () => {
      if (attached) return { events: [], dropped: 0 };
      const pending = events.splice(0);
      const pendingDropped = dropped;
      dropped = 0;
      return {
        events: Object.freeze(pending),
        dropped: pendingDropped,
      };
    },
  });
}

export interface AcquireHostRuntimeLeaseInput {
  readonly command: string;
  readonly cwd: string;
  readonly projectDir: string;
  readonly scope: CommandScopeRequirement;
  readonly policy: HostCommandRuntimePolicy;
  readonly ownerToken?: string;
  readonly onEvent?: (event: RuntimeLeaseEvent | FileLockEvent) => void;
}

export interface HostRuntimeLeaseAcquisitionDeps {
  readonly acquireRuntimeReadLease?: typeof acquireRuntimeReadLease;
  readonly acquireUserStateReadLease?: typeof acquireUserStateReadLease;
  readonly acquireRuntimeAccessLease?: typeof acquireRuntimeAccessLease;
}

export type RuntimeLeaseLifecycleState = 'bootstrap' | 'scope' | 'released' | 'retained';

/**
 * CLI-only ownership controller. It prevents an outer failure path from
 * releasing a lease after scope teardown failed to prove SQLite was closed.
 */
export interface RuntimeLeaseLifecycle {
  readonly lease: RuntimeLease | undefined;
  readonly state: () => RuntimeLeaseLifecycleState;
  readonly transferToScope: () => void;
  readonly releaseBootstrapOwned: () => void;
  readonly finishAfterDatastoreClose: (result: DatastoreCloseResult) => void;
}

export function createRuntimeLeaseLifecycle(
  lease: RuntimeLease | undefined,
  retainedLeases: readonly RuntimeLease[] = [],
): RuntimeLeaseLifecycle {
  const leases = [
    ...(lease === undefined ? [] : [lease]),
    ...retainedLeases.filter((candidate) => candidate !== lease),
  ];
  let state: RuntimeLeaseLifecycleState = leases.length === 0 ? 'released' : 'bootstrap';

  /** @throws {Error | SystemError} When any retained runtime lease cannot be released. */
  function releaseAll(): void {
    let firstError: unknown;
    for (const held of leases) {
      try {
        held.release();
      } catch (error) {
        firstError ??= error;
      }
    }
    state = firstError === undefined ? 'released' : 'retained';
    if (firstError instanceof Error) throw firstError;
    if (firstError !== undefined) {
      throw new SystemError('Runtime lease release failed with an unknown error.', {
        code: LEASE_RELEASE_FAILED.code,
        definition: LEASE_RELEASE_FAILED,
        cause: firstError,
      });
    }
  }

  return Object.freeze({
    lease: lease ?? retainedLeases[0],
    state: () => state,
    transferToScope: (): void => {
      if (state === 'bootstrap') state = 'scope';
    },
    releaseBootstrapOwned: (): void => {
      if (state !== 'bootstrap' || leases.length === 0) return;
      releaseAll();
    },
    finishAfterDatastoreClose: (result: DatastoreCloseResult): void => {
      if ((state !== 'bootstrap' && state !== 'scope') || leases.length === 0) return;
      if (result.closed) {
        releaseAll();
      } else {
        // The live process and heartbeat keep promotion blocked. We
        // deliberately retain the reader until process exit/stale recovery.
        state = 'retained';
      }
    },
  });
}

/**
 * Acquire the command's complete shared runtime footprint in one phase.
 * Scope-none/default commands add no command-phase lease (standard startup may
 * already hold the project+user discovery reader). Inspection-only commands
 * bypass standard startup and acquire none at either phase.
 */
/**
 * Process-local ownership proof for host mutations under a declared runtime
 * lease. Handler helpers (plugin install, configure writers) assert this before
 * any user/project I/O so a nested path cannot mutate without the command's
 * declared lease. Same-owner reentry preserves the token; release clears it.
 */
interface EnteredHostOwnership {
  readonly ownerToken: string;
  readonly userState: boolean;
  readonly project: boolean;
}

let enteredHostOwnership: EnteredHostOwnership | undefined;

function recordEnteredOwnership(lease: RuntimeLease): void {
  const kind = 'kind' in lease ? String((lease as { readonly kind?: string }).kind) : '';
  const composite =
    kind === 'runtime-access-composite'
      ? (lease as {
          readonly userStateRead?: boolean;
          readonly projectRead?: boolean;
        })
      : undefined;
  const userState = kind === 'user-state-read' || composite?.userStateRead === true;
  const project =
    kind === 'runtime-read' || kind === 'runtime-exclusive' || composite?.projectRead === true;
  enteredHostOwnership = Object.freeze({
    ownerToken: lease.ownerToken,
    userState,
    project,
  });
}

function clearEnteredOwnership(ownerToken: string): void {
  if (enteredHostOwnership?.ownerToken === ownerToken) {
    enteredHostOwnership = undefined;
  }
}

/** Assert the current command holds user-state authority before user-root I/O. */
export function assertEnteredUserStateOwner(operation: string): void {
  if (enteredHostOwnership?.userState !== true) {
    throw new SystemError(
      `Host user-state mutation '${operation}' requires an entered user-state runtime lease.`,
      {
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'user-state-owner' },
      },
    );
  }
}

/** Assert the current command holds project authority before project-host I/O. */
export function assertEnteredProjectOwner(operation: string): void {
  if (enteredHostOwnership?.project !== true) {
    throw new SystemError(
      `Host project mutation '${operation}' requires an entered project runtime lease.`,
      {
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'project-owner' },
      },
    );
  }
}

/** Test-only: clear entered ownership between cases. */
export function resetEnteredHostOwnershipForTests(): void {
  enteredHostOwnership = undefined;
}

/** Test-only: seed entered ownership without a live coordination lease. */
export function enterHostOwnershipForTests(args: {
  readonly userState?: boolean;
  readonly project?: boolean;
  readonly ownerToken?: string;
}): void {
  enteredHostOwnership = Object.freeze({
    ownerToken: args.ownerToken ?? 'test-owner-token',
    userState: args.userState === true,
    project: args.project === true,
  });
}

/**
 * Run `fn` under entered user-state ownership. Reuses an existing user-state
 * owner when present; otherwise acquires a short user-state lease (optionally
 * reentering with the same owner token as an existing project lease) and
 * releases it before returning. Used by bootstrap update-state writes.
 */
export async function runWithUserStateOwnership(
  opts: {
    readonly command: string;
    readonly cwdBasename?: string;
    readonly ownerToken?: string;
  },
  fn: () => void | Promise<void>,
): Promise<void> {
  if (enteredHostOwnership?.userState === true) {
    await fn();
    return;
  }
  const lease = await acquireUserStateReadLease({
    command: opts.command,
    cwdBasename: opts.cwdBasename ?? 'opensip',
    ...(opts.ownerToken === undefined ? {} : { ownerToken: opts.ownerToken }),
  });
  recordEnteredOwnership(lease);
  try {
    await fn();
  } finally {
    clearEnteredOwnership(lease.ownerToken);
    lease.release();
  }
}

export async function acquireHostRuntimeLease(
  input: AcquireHostRuntimeLeaseInput,
  deps: HostRuntimeLeaseAcquisitionDeps = {},
): Promise<RuntimeLease | undefined> {
  if (input.policy.bootstrapMode === INSPECTION_ONLY) return undefined;
  const common = {
    command: input.command,
    cwdBasename: basename(input.cwd),
    ...(input.ownerToken === undefined ? {} : { ownerToken: input.ownerToken }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  };
  let lease: RuntimeLease | undefined;
  if (input.policy.runtimeAccess === 'project-and-user-state') {
    lease = await (deps.acquireRuntimeAccessLease ?? acquireRuntimeAccessLease)({
      ...common,
      projectRead: { projectDir: input.projectDir },
      userStateRead: true,
    });
  } else if (input.policy.runtimeAccess === 'user-state') {
    if (input.scope === 'project') {
      lease = await (deps.acquireRuntimeAccessLease ?? acquireRuntimeAccessLease)({
        ...common,
        projectRead: { projectDir: input.projectDir },
        userStateRead: true,
      });
    } else {
      lease = await (deps.acquireUserStateReadLease ?? acquireUserStateReadLease)(common);
    }
  } else if (input.scope === 'project') {
    lease = await (deps.acquireRuntimeReadLease ?? acquireRuntimeReadLease)({
      ...common,
      projectDir: input.projectDir,
    });
  } else {
    return undefined;
  }
  if (lease === undefined) return undefined;
  recordEnteredOwnership(lease);
  const originalRelease = lease.release.bind(lease);
  const wrapped: RuntimeLease = Object.freeze({
    ...lease,
    release: (): void => {
      clearEnteredOwnership(lease.ownerToken);
      originalRelease();
    },
  });
  return wrapped;
}
