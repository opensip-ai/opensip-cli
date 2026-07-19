import { lstatSync } from 'node:fs';
import { basename } from 'node:path';

import {
  acquireRuntimeReadLease,
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  inspectRuntimeLeaseState,
  resolveCoordinationPaths,
  resolveEphemeralProjectPaths,
  resolveProjectContext,
  type ProjectContext,
  type RuntimeLeaseStateInspection,
  type RuntimeReadLease,
} from '@opensip-cli/core';

import { loadCliDefaults } from '../bootstrap/cli-defaults.js';
import {
  resolveSessionRetentionPolicy,
  type SessionRetentionPolicy,
} from '../bootstrap/session-retention.js';

import {
  inspectRuntimePromotionStatus,
  type RuntimePromotionStatusInspection,
} from './init/runtime-promotion-status.js';
import { safePathExists, type RuntimeStatusSizeLimits } from './runtime-status-filesystem.js';

import type {
  RuntimeCacheLocationProjection,
  RuntimeLeaseActivity,
  RuntimeStatusResult,
} from '@opensip-cli/contracts';

/** A status read is bounded even when the runtime contains hostile content. */
export const RUNTIME_STATUS_MAX_ENTRIES = 10_000;
export const RUNTIME_STATUS_MAX_BYTES = 1024 * 1024 * 1024;
/** Status observes maintenance rather than waiting behind a long promotion. */
export const RUNTIME_STATUS_LEASE_WAIT_MS = 250;

export type RuntimeStatusCoordinationRootPresence = 'absent' | 'present' | 'unsafe';

/** Injectable bounded coordination seams used by race-focused status tests. */
export interface RuntimeStatusCoordination {
  readonly rootPresence: () => RuntimeStatusCoordinationRootPresence;
  readonly inspect: (projectDir: string) => Promise<RuntimeLeaseStateInspection>;
  readonly inspectPromotion: (
    projectRoot: string,
    coordinationKey: string,
  ) => RuntimePromotionStatusInspection;
  readonly acquireRead: (projectDir: string) => Promise<RuntimeReadLease>;
}

export interface ExecuteRuntimeStatusInput {
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  /** Preserve the customer's exact `--config` authority across lease re-resolution. */
  readonly explicitConfigPath?: string;
  /** Preserve bootstrap's explicit-config authority when it is available. */
  readonly projectContext?: ProjectContext;
  /** Test seam for proving traversal caps without creating a huge fixture. */
  readonly sizeLimits?: Partial<RuntimeStatusSizeLimits>;
  /** Test seam for deterministic coordination races and timeouts. */
  readonly coordination?: Partial<RuntimeStatusCoordination>;
}

export interface RuntimeStatusContext {
  readonly project: ProjectContext;
  readonly coordinationKey: string;
  readonly limits: RuntimeStatusSizeLimits;
  readonly projectInitialized: boolean;
  readonly cacheIdentityStrength: RuntimeCacheLocationProjection['identityStrength'];
  readonly retention: SessionRetentionPolicy;
}

function effectiveEvidenceRetention(project: ProjectContext): SessionRetentionPolicy {
  const defaults = loadCliDefaults(project.projectRoot, project.configPath);
  return resolveSessionRetentionPolicy(defaults.sessions);
}

function runtimeCoordinationRootPresence(): RuntimeStatusCoordinationRootPresence {
  try {
    const stat = lstatSync(resolveCoordinationPaths().coordinationDir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'present' : 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unsafe';
  }
}

function defaultCoordination(): RuntimeStatusCoordination {
  return {
    rootPresence: runtimeCoordinationRootPresence,
    inspect: inspectRuntimeLeaseState,
    inspectPromotion: (projectRoot, coordinationKey) =>
      inspectRuntimePromotionStatus({ projectRoot, coordinationKey }),
    acquireRead: (projectDir) =>
      acquireRuntimeReadLease({
        projectDir,
        command: 'opensip status',
        cwdBasename: basename(projectDir),
        policy: {
          waitMs: RUNTIME_STATUS_LEASE_WAIT_MS,
          pollMs: 10,
        },
      }),
  };
}

/** Resolve production coordination behavior with optional deterministic test seams. */
export function resolveStatusCoordination(
  override: Partial<RuntimeStatusCoordination> | undefined,
): RuntimeStatusCoordination {
  const defaults = defaultCoordination();
  return {
    rootPresence: override?.rootPresence ?? defaults.rootPresence,
    inspect: override?.inspect ?? defaults.inspect,
    inspectPromotion: override?.inspectPromotion ?? defaults.inspectPromotion,
    acquireRead: override?.acquireRead ?? defaults.acquireRead,
  };
}

/** Resolve the project and bounded storage limits protected by a status read. */
export function buildRuntimeStatusContext(
  input: ExecuteRuntimeStatusInput,
  reuseBootstrapContext = true,
): RuntimeStatusContext {
  const project =
    reuseBootstrapContext && input.projectContext !== undefined
      ? input.projectContext
      : resolveProjectContext({
          cwd: input.cwd,
          cwdExplicit: input.cwdExplicit,
          ...(input.explicitConfigPath === undefined
            ? {}
            : { explicitConfigPath: input.explicitConfigPath }),
        });
  const cachePaths = resolveEphemeralProjectPaths(project.projectRoot);
  return {
    project,
    coordinationKey: cachePaths.coordinationKey,
    limits: {
      maxEntries: input.sizeLimits?.maxEntries ?? RUNTIME_STATUS_MAX_ENTRIES,
      maxBytes: input.sizeLimits?.maxBytes ?? RUNTIME_STATUS_MAX_BYTES,
    },
    projectInitialized:
      project.scope === 'project' &&
      project.configPath !== undefined &&
      safePathExists(project.configPath),
    cacheIdentityStrength: cachePaths.identityStrength,
    retention: effectiveEvidenceRetention(project),
  };
}

function unavailableBase(context: RuntimeStatusContext) {
  return {
    type: 'runtime-status' as const,
    inspectionUnavailable: true as const,
    projectInitialized: context.projectInitialized,
    activePlane: context.projectInitialized ? ('project' as const) : ('none' as const),
    cache: {
      exists: false,
      identityStrength: context.cacheIdentityStrength,
    },
    project: { exists: false },
    evidenceDatabase: { exists: false },
    retention: {
      cache: {
        keep: DEFAULT_EPHEMERAL_KEEP,
        maxAgeDays: DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
      },
      evidence: context.retention,
    },
  };
}

/** Project a bounded busy response when storage cannot be inspected safely. */
export function busyStatus(
  context: RuntimeStatusContext,
  leaseActivity?: RuntimeLeaseActivity,
): RuntimeStatusResult {
  return {
    ...unavailableBase(context),
    adoptionState: 'busy',
    ...(leaseActivity === undefined ? {} : { leaseActivity }),
    nextCommands: [],
  };
}

/** Project an explicit promotion-recovery response. */
export function recoveryStatus(
  context: RuntimeStatusContext,
  projection: Extract<RuntimePromotionStatusInspection, { readonly status: 'recovery-required' }>,
  leaseActivity: RuntimeLeaseActivity,
): RuntimeStatusResult {
  return {
    ...unavailableBase(context),
    adoptionState: 'recovery-required',
    leaseActivity,
    recoveryPhase: projection.recoveryPhase,
    recoveryReasonCode: projection.recoveryReasonCode,
    recoveryCommand: projection.recoveryCommand,
    nextCommands: [projection.recoveryCommand],
  };
}
