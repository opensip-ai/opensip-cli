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
  defineCommand,
  SystemError,
  type CommandScopeRequirement,
  type CommandSpec,
  type FileLockEvent,
  type RuntimeLease,
  type RuntimeLeaseEvent,
} from '@opensip-cli/core';

import type { DatastoreCloseResult } from '@opensip-cli/datastore';

/** Additional shared runtime resources required by a CLI-owned host command. */
export type HostRuntimeAccess = 'default' | 'user-state' | 'project-and-user-state';

/** Bootstrap posture for a CLI-owned host command. */
export type HostBootstrapMode = 'standard' | 'inspection-only';

/** Frozen CLI-private policy copied into the command-scope index. */
export interface HostCommandRuntimePolicy {
  readonly runtimeAccess: HostRuntimeAccess;
  readonly bootstrapMode: HostBootstrapMode;
}

export const DEFAULT_HOST_RUNTIME_POLICY: HostCommandRuntimePolicy = Object.freeze({
  runtimeAccess: 'default',
  bootstrapMode: 'standard',
});
const INSPECTION_ONLY = 'inspection-only' as const;
const HOST_RUNTIME_ACCESS_VALUES = new Set<unknown>([
  'default',
  'user-state',
  'project-and-user-state',
]);
const HOST_BOOTSTRAP_MODE_VALUES = new Set<unknown>(['standard', INSPECTION_ONLY]);

/** A core CommandSpec decorated with CLI-private host runtime facts. */
export type HostRuntimeCommandSpec<TOpts = unknown, TCtx = unknown> = CommandSpec<TOpts, TCtx> & {
  readonly hostRuntimePolicy?: HostCommandRuntimePolicy;
};

function validatePolicyObject(policy: Partial<HostCommandRuntimePolicy>): void {
  const prototype = Object.getPrototypeOf(policy) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Host runtime policy must be a plain object.');
  }
  const allowed = new Set(['runtimeAccess', 'bootstrapMode']);
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`Unsupported host runtime policy field '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(policy, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Host runtime policy field '${key}' must be an own data property.`);
    }
  }
}

function ownPolicyValue(
  policy: Partial<HostCommandRuntimePolicy>,
  key: keyof HostCommandRuntimePolicy,
  fallback: HostRuntimeAccess | HostBootstrapMode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(policy, key);
  return descriptor === undefined ? fallback : descriptor.value;
}

function freezeHostRuntimePolicy(
  policy: Partial<HostCommandRuntimePolicy> | undefined,
): HostCommandRuntimePolicy {
  const candidate = policy ?? {};
  validatePolicyObject(candidate);
  const runtimeAccess = ownPolicyValue(
    candidate,
    'runtimeAccess',
    DEFAULT_HOST_RUNTIME_POLICY.runtimeAccess,
  );
  const bootstrapMode = ownPolicyValue(
    candidate,
    'bootstrapMode',
    DEFAULT_HOST_RUNTIME_POLICY.bootstrapMode,
  );
  if (!HOST_RUNTIME_ACCESS_VALUES.has(runtimeAccess)) {
    throw new TypeError(`Unsupported host runtime access '${String(runtimeAccess)}'.`);
  }
  if (!HOST_BOOTSTRAP_MODE_VALUES.has(bootstrapMode)) {
    throw new TypeError(`Unsupported host bootstrap mode '${String(bootstrapMode)}'.`);
  }
  return Object.freeze({
    runtimeAccess: runtimeAccess as HostRuntimeAccess,
    bootstrapMode: bootstrapMode as HostBootstrapMode,
  });
}

/**
 * Validate/freeze the ordinary public CommandSpec first, then create a new
 * frozen host-only decorated copy. Unknown host fields never enter core.
 */
export function defineHostCommand<TOpts = unknown, TCtx = unknown>(
  spec: CommandSpec<TOpts, TCtx>,
  policy?: Partial<HostCommandRuntimePolicy>,
): HostRuntimeCommandSpec<TOpts, TCtx> {
  const defined = defineCommand(spec);
  if (policy === undefined) return Object.freeze({ ...defined });
  const frozenPolicy = freezeHostRuntimePolicy(policy);
  if (
    frozenPolicy.bootstrapMode === INSPECTION_ONLY &&
    (defined.scope !== 'none' || frozenPolicy.runtimeAccess !== 'default')
  ) {
    throw new TypeError(
      'Inspection-only bootstrap is limited to scope-none host commands with default runtime access.',
    );
  }
  return Object.freeze({
    ...defined,
    hostRuntimePolicy: frozenPolicy,
  });
}

/** Normalize an optional decorated policy into the closed default vocabulary. */
export function resolveHostRuntimePolicy(
  policy: HostCommandRuntimePolicy | undefined,
): HostCommandRuntimePolicy {
  return policy === undefined ? DEFAULT_HOST_RUNTIME_POLICY : freezeHostRuntimePolicy(policy);
}

/** Validate the policy/scope relation at the host inventory trust boundary. */
export function resolveHostRuntimePolicyForScope(
  scope: CommandScopeRequirement,
  policy: HostCommandRuntimePolicy | undefined,
): HostCommandRuntimePolicy {
  const resolved = resolveHostRuntimePolicy(policy);
  if (
    resolved.bootstrapMode === INSPECTION_ONLY &&
    (scope !== 'none' || resolved.runtimeAccess !== 'default')
  ) {
    throw new TypeError(
      'Inspection-only bootstrap is limited to scope-none host commands with default runtime access.',
    );
  }
  return resolved;
}

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
  const releaseAll = (): void => {
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
        code: 'SYSTEM.RUNTIME_LEASE.RELEASE_FAILED',
        cause: firstError,
      });
    }
  };
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
  const userState =
    kind === 'user-state-read' || (composite !== undefined && composite.userStateRead === true);
  const project =
    kind === 'runtime-read' ||
    kind === 'runtime-exclusive' ||
    (composite !== undefined && composite.projectRead === true);
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
      { code: 'SYSTEM.HOST_RUNTIME.USER_STATE_OWNER_REQUIRED' },
    );
  }
}

/** Assert the current command holds project authority before project-host I/O. */
export function assertEnteredProjectOwner(operation: string): void {
  if (enteredHostOwnership?.project !== true) {
    throw new SystemError(
      `Host project mutation '${operation}' requires an entered project runtime lease.`,
      { code: 'SYSTEM.HOST_RUNTIME.PROJECT_OWNER_REQUIRED' },
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

/** Whether stabilization must compare the path-stable project coordination key. */
export function hostPolicyNeedsProjectCoordination(
  scope: CommandScopeRequirement,
  policy: HostCommandRuntimePolicy,
): boolean {
  if (policy.bootstrapMode === INSPECTION_ONLY) return false;
  return scope === 'project' || policy.runtimeAccess === 'project-and-user-state';
}

/**
 * Exact root-command pre-scan used to skip Tool discovery. The allowed names
 * come from live decorated host specs rather than a parallel verb allowlist.
 */
export function isInspectionOnlyHostRequest(
  argv: readonly string[],
  hostSpecs: readonly Pick<
    HostRuntimeCommandSpec,
    'name' | 'aliases' | 'scope' | 'hostRuntimePolicy'
  >[],
): boolean {
  let index = 0;
  while (argv[index] === '--no-cloud' || argv[index] === '--no-plugins') index += 1;
  const verb = argv[index];
  if (verb === undefined) return false;
  return hostSpecs.some(
    (spec) =>
      (spec.name === verb || spec.aliases?.includes(verb) === true) &&
      spec.scope === 'none' &&
      resolveHostRuntimePolicy(spec.hostRuntimePolicy).bootstrapMode === INSPECTION_ONLY,
  );
}
