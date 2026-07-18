/**
 * Read-only projection of the current project's local OpenSIP storage.
 *
 * This module deliberately uses filesystem metadata only. It never opens
 * SQLite, touches cache markers, creates a runtime, or prunes another entry.
 */

import { lstatSync, opendirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import {
  acquireRuntimeReadLease,
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  inspectEphemeralRuntimeCandidates,
  inspectRuntimeLeaseState,
  resolveCoordinationPaths,
  resolveEphemeralProjectPaths,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralRuntimeCandidate,
  type ProjectContext,
  type RuntimeLeaseStateInspection,
  type RuntimeReadLease,
} from '@opensip-cli/core';

import { loadCliDefaults } from '../bootstrap/cli-defaults.js';
import {
  resolveSessionRetentionPolicy,
  type SessionRetentionPolicy,
} from '../bootstrap/session-retention.js';

import type {
  RuntimeAdoptionState,
  RuntimeCacheLocationProjection,
  RuntimeEvidenceDatabaseProjection,
  RuntimeLeaseActivity,
  RuntimeLocationProjection,
  RuntimeNextCommand,
  RuntimeStatusResult,
  RuntimeStoragePlane,
} from '@opensip-cli/contracts';

const DATASTORE_FILE = 'datastore.sqlite';

/** A status read is bounded even when the runtime contains hostile content. */
export const RUNTIME_STATUS_MAX_ENTRIES = 10_000;
export const RUNTIME_STATUS_MAX_BYTES = 1024 * 1024 * 1024;
/** Status should observe maintenance, not wait behind a long-running promotion. */
export const RUNTIME_STATUS_LEASE_WAIT_MS = 250;

interface RuntimeSizeLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export type RuntimeStatusCoordinationRootPresence = 'absent' | 'present' | 'unsafe';

/** Injectable bounded coordination seams used by race-focused status tests. */
export interface RuntimeStatusCoordination {
  readonly rootPresence: () => RuntimeStatusCoordinationRootPresence;
  readonly inspect: (projectDir: string) => Promise<RuntimeLeaseStateInspection>;
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
  readonly sizeLimits?: Partial<RuntimeSizeLimits>;
  /** Test seam for deterministic coordination races and timeouts. */
  readonly coordination?: Partial<RuntimeStatusCoordination>;
}

interface BoundedSize {
  readonly sizeBytes: number;
  readonly sizeTruncated: boolean;
}

type RuntimePathInspection = 'missing' | 'trusted' | 'unsafe';

interface SizeAccumulator {
  sizeBytes: number;
  sizeTruncated: boolean;
  entries: number;
}

interface RuntimeStatusContext {
  readonly project: ProjectContext;
  readonly coordinationKey: string;
  readonly limits: RuntimeSizeLimits;
  readonly projectInitialized: boolean;
  readonly cacheIdentityStrength: RuntimeCacheLocationProjection['identityStrength'];
  readonly retention: SessionRetentionPolicy;
}

function safePathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function addRuntimeEntry(
  path: string,
  limits: RuntimeSizeLimits,
  state: SizeAccumulator,
  pending: string[],
): void {
  state.entries++;
  if (state.entries > limits.maxEntries) {
    state.sizeTruncated = true;
    return;
  }
  const stat = safeLstat(path);
  if (stat === undefined) {
    state.sizeTruncated = true;
    return;
  }
  const remaining = limits.maxBytes - state.sizeBytes;
  if (Number(stat.size) > remaining) {
    state.sizeBytes = limits.maxBytes;
    state.sizeTruncated = true;
    return;
  }
  state.sizeBytes += Number(stat.size);
  if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(path);
}

function scanDirectory(
  directory: string,
  limits: RuntimeSizeLimits,
  state: SizeAccumulator,
  pending: string[],
): void {
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    while (!state.sizeTruncated) {
      const entry = handle.readSync();
      if (entry === null) break;
      addRuntimeEntry(join(directory, entry.name), limits, state, pending);
    }
  } catch {
    state.sizeTruncated = true;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      state.sizeTruncated = true;
    }
  }
}

function boundedSize(root: string, limits: RuntimeSizeLimits): BoundedSize | undefined {
  const rootStat = safeLstat(root);
  if (rootStat === undefined) return undefined;
  const state: SizeAccumulator = {
    sizeBytes: Math.min(Number(rootStat.size), limits.maxBytes),
    sizeTruncated: Number(rootStat.size) > limits.maxBytes,
    entries: 1,
  };
  const pending = rootStat.isDirectory() && !rootStat.isSymbolicLink() ? [root] : [];

  while (pending.length > 0 && !state.sizeTruncated) {
    const directory = pending.pop();
    if (directory === undefined) break;
    scanDirectory(directory, limits, state, pending);
  }

  return { sizeBytes: state.sizeBytes, sizeTruncated: state.sizeTruncated };
}

function inspectRuntimePath(anchor: string, runtimeDir: string): RuntimePathInspection {
  const relativePath = relative(anchor, runtimeDir);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    return 'unsafe';
  }
  const parts = relativePath === '' ? [] : relativePath.split(sep);
  let current = anchor;
  for (const part of ['', ...parts]) {
    if (part !== '') current = join(current, part);
    const stat = safeLstat(current);
    if (stat === undefined) return 'missing';
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
  }
  return 'trusted';
}

function locationProjection(
  runtimeDir: string,
  inspection: RuntimePathInspection,
  limits: RuntimeSizeLimits,
): RuntimeLocationProjection {
  if (inspection === 'missing') return { exists: false };
  if (inspection === 'unsafe') return { exists: true, sizeTruncated: true };
  const size = boundedSize(runtimeDir, limits);
  return size === undefined ? { exists: false } : { exists: true, ...size };
}

function evidenceDatabaseProjection(path: string | undefined): RuntimeEvidenceDatabaseProjection {
  if (path === undefined) return { exists: false };
  const stat = safeLstat(path);
  if (stat === undefined) return { exists: false };
  if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true };
  return { exists: true, sizeBytes: Number(stat.size) };
}

function markerLastUsedAt(candidate: EphemeralRuntimeCandidate): string | undefined {
  const marker = candidate.marker;
  return marker.status === 'current' || marker.status === 'legacy'
    ? marker.marker.lastUsedAt
    : undefined;
}

function selectedCacheCandidate(
  active: EphemeralRuntimeCandidate,
  legacy: EphemeralRuntimeCandidate | undefined,
): EphemeralRuntimeCandidate {
  return active.exists || legacy === undefined ? active : legacy;
}

function cacheProjection(
  candidate: EphemeralRuntimeCandidate,
  hasAdditionalLegacy: boolean,
  inspection: RuntimePathInspection,
  limits: RuntimeSizeLimits,
): RuntimeCacheLocationProjection {
  const location = locationProjection(candidate.runtimeDir, inspection, limits);
  const unsafe = inspection === 'unsafe';
  return {
    ...location,
    identityStrength:
      hasAdditionalLegacy || unsafe ? 'legacy-unverified' : candidate.identityStrength,
    ...(unsafe || markerLastUsedAt(candidate) === undefined
      ? {}
      : { lastUsedAt: markerLastUsedAt(candidate) }),
  };
}

function adoptionState(input: {
  readonly cache: RuntimeCacheLocationProjection;
  readonly projectInitialized: boolean;
  readonly projectRuntimeExists: boolean;
  readonly hasAdditionalLegacy: boolean;
}): Exclude<RuntimeAdoptionState, 'busy' | 'recovery-required'> {
  const weakCache =
    input.cache.exists &&
    (input.cache.identityStrength !== 'generation-bound' || input.hasAdditionalLegacy);
  if (weakCache) return 'legacy-unverified';

  const authoritativeProject = input.projectInitialized || input.projectRuntimeExists;
  if (authoritativeProject && input.cache.exists) return 'conflict';
  if (input.cache.exists) return 'ready';
  return 'not-needed';
}

function activePlane(projectInitialized: boolean, cacheExists: boolean): RuntimeStoragePlane {
  if (projectInitialized) return 'project';
  return cacheExists ? 'cache' : 'none';
}

function selectedRuntimeDir(input: {
  readonly plane: RuntimeStoragePlane;
  readonly projectRuntimeDir: string;
  readonly cacheRuntimeDir: string;
}): string | undefined {
  if (input.plane === 'project') return input.projectRuntimeDir;
  if (input.plane === 'cache') return input.cacheRuntimeDir;
  return undefined;
}

function selectedRuntimeInspection(input: {
  readonly plane: RuntimeStoragePlane;
  readonly project: RuntimePathInspection;
  readonly cache: RuntimePathInspection;
}): RuntimePathInspection {
  if (input.plane === 'project') return input.project;
  if (input.plane === 'cache') return input.cache;
  return 'missing';
}

function nextCommands(input: {
  readonly initialized: boolean;
  readonly projectRuntimeExists: boolean;
  readonly evidenceExists: boolean;
  readonly adoptionState: Exclude<RuntimeAdoptionState, 'busy' | 'recovery-required'>;
}): readonly RuntimeNextCommand[] {
  const commands: RuntimeNextCommand[] = [];
  if (!input.initialized || input.adoptionState !== 'not-needed') {
    commands.push('opensip init');
  }
  if (input.evidenceExists) {
    commands.push('opensip runs list --json', 'opensip sessions list --json');
  }
  if (input.initialized || input.projectRuntimeExists) {
    commands.push('opensip uninstall --project --dry-run');
  }
  return commands;
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

function resolveStatusCoordination(
  override: Partial<RuntimeStatusCoordination> | undefined,
): RuntimeStatusCoordination {
  const defaults = defaultCoordination();
  return {
    rootPresence: override?.rootPresence ?? defaults.rootPresence,
    inspect: override?.inspect ?? defaults.inspect,
    acquireRead: override?.acquireRead ?? defaults.acquireRead,
  };
}

function buildRuntimeStatusContext(
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

function busyStatus(
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

function recoveryStatus(
  context: RuntimeStatusContext,
  reason: 'operation-interrupted' | 'journal-malformed',
  leaseActivity: RuntimeLeaseActivity,
): RuntimeStatusResult {
  return {
    ...unavailableBase(context),
    adoptionState: 'recovery-required',
    leaseActivity,
    recoveryPhase: 'unknown',
    recoveryReasonCode: reason,
    recoveryCommand: 'opensip init',
    nextCommands: ['opensip init'],
  };
}

type StableLeaseInspection = Extract<RuntimeLeaseStateInspection, { readonly status: 'stable' }>;

function leaseActivity(
  inspection: StableLeaseInspection,
  includesStatusReader: boolean,
  forceBusy: boolean,
): RuntimeLeaseActivity {
  const writerPending = inspection.writer !== 'none' || inspection.globalWriter !== 'none';
  return {
    activeReaders: Math.max(0, inspection.projectReaders - (includesStatusReader ? 1 : 0)),
    writerPending,
    busy: forceBusy || writerPending,
  };
}

function blockingStatus(
  context: RuntimeStatusContext,
  inspection: RuntimeLeaseStateInspection,
  includesStatusReader: boolean,
): RuntimeStatusResult | undefined {
  if (inspection.status === 'busy') return busyStatus(context);
  const activity = leaseActivity(inspection, includesStatusReader, true);
  if (inspection.promotion.status === 'malformed') {
    return recoveryStatus(context, 'journal-malformed', activity);
  }
  if (inspection.promotion.status === 'valid' && inspection.promotion.state === 'open') {
    return recoveryStatus(context, 'operation-interrupted', activity);
  }
  if (
    inspection.userUninstall.status === 'malformed' ||
    (inspection.userUninstall.status === 'valid' && inspection.userUninstall.state === 'open') ||
    activity.writerPending
  ) {
    return busyStatus(context, activity);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isBoundedCoordinationFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'CONFIGURATION.RECOVERY_REQUIRED' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.BUSY' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.EXISTS' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' ||
    code === 'SYSTEM.RUNTIME_LEASE.CAPACITY' ||
    code === 'SYSTEM.RUNTIME_LEASE.CLEANUP_CAPACITY' ||
    code === 'TIMEOUT.RUNTIME_READ'
  );
}

async function inspectCoordination(
  coordination: RuntimeStatusCoordination,
  projectRoot: string,
): Promise<RuntimeLeaseStateInspection | undefined> {
  try {
    return await coordination.inspect(projectRoot);
  } catch (error) {
    if (isBoundedCoordinationFailure(error)) return;
    throw error;
  }
}

function inspectRuntimeStorage(context: RuntimeStatusContext) {
  const { project, limits, projectInitialized } = context;
  const projectPaths = resolveProjectPaths(project.projectRoot);
  const candidates = inspectEphemeralRuntimeCandidates(project.projectRoot);
  const chosenCache = selectedCacheCandidate(candidates.active, candidates.legacy);
  const hasAdditionalLegacy = candidates.legacy !== undefined && candidates.active.exists;
  const cacheInspection = inspectRuntimePath(
    resolveUserPaths().userHomeDir,
    chosenCache.runtimeDir,
  );
  const projectInspection = inspectRuntimePath(project.projectRoot, projectPaths.runtimeDir);
  const cache = cacheProjection(chosenCache, hasAdditionalLegacy, cacheInspection, limits);
  const projectLocation = locationProjection(projectPaths.runtimeDir, projectInspection, limits);
  const plane = activePlane(projectInitialized, cache.exists);
  const selectedRuntime = selectedRuntimeDir({
    plane,
    projectRuntimeDir: projectPaths.runtimeDir,
    cacheRuntimeDir: chosenCache.runtimeDir,
  });
  const evidencePath =
    selectedRuntime === undefined ? undefined : join(selectedRuntime, DATASTORE_FILE);
  const selectedInspection = selectedRuntimeInspection({
    plane,
    project: projectInspection,
    cache: cacheInspection,
  });
  const evidenceDatabase =
    selectedInspection === 'trusted'
      ? evidenceDatabaseProjection(evidencePath)
      : ({ exists: false } as const);
  const state = adoptionState({
    cache,
    projectInitialized,
    projectRuntimeExists: projectLocation.exists,
    hasAdditionalLegacy,
  });

  return {
    type: 'runtime-status' as const,
    projectInitialized,
    activePlane: plane,
    cache,
    project: projectLocation,
    evidenceDatabase,
    adoptionState: state,
    retention: {
      cache: {
        keep: DEFAULT_EPHEMERAL_KEEP,
        maxAgeDays: DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
      },
      evidence: context.retention,
    },
    nextCommands: nextCommands({
      initialized: projectInitialized,
      projectRuntimeExists: projectLocation.exists,
      evidenceExists: evidenceDatabase.exists,
      adoptionState: state,
    }),
  };
}

type InspectedRuntimeStatus = ReturnType<typeof inspectRuntimeStorage>;

function completedStatus(
  inspected: InspectedRuntimeStatus,
  activity: RuntimeLeaseActivity,
  cleanupPending: boolean,
): RuntimeStatusResult {
  if (cleanupPending) {
    return {
      ...inspected,
      leaseActivity: activity,
      recoveryPhase: 'cleanup',
      recoveryReasonCode: 'cleanup-pending',
      cleanupPending: true,
      recoveryCommand: 'opensip init',
    };
  }
  return { ...inspected, leaseActivity: activity };
}

function closedPromotion(inspection: StableLeaseInspection): boolean {
  return inspection.promotion.status === 'valid' && inspection.promotion.state === 'closed';
}

async function inspectRuntimeStorageUnderLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<RuntimeStatusResult> {
  const underLease = await inspectCoordination(coordination, context.project.projectRoot);
  if (underLease === undefined) return busyStatus(context);
  const blockedUnderLease = blockingStatus(context, underLease, true);
  if (blockedUnderLease !== undefined) return blockedUnderLease;
  if (underLease.status !== 'stable' || underLease.projectReaders < 1) {
    return busyStatus(context);
  }

  const inspected = inspectRuntimeStorage(context);
  const finalInspection = await inspectCoordination(coordination, context.project.projectRoot);
  if (finalInspection === undefined) return busyStatus(context);
  const blockedAfterRead = blockingStatus(context, finalInspection, true);
  if (blockedAfterRead !== undefined) return blockedAfterRead;
  if (finalInspection.status !== 'stable' || finalInspection.projectReaders < 1) {
    return busyStatus(context);
  }

  return completedStatus(
    inspected,
    leaseActivity(finalInspection, true, false),
    closedPromotion(finalInspection),
  );
}

function releaseStatusLease(lease: RuntimeReadLease): boolean {
  try {
    lease.release();
    return true;
  } catch {
    return false;
  }
}

function statusWithoutCoordination(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): RuntimeStatusResult {
  const inspected = inspectRuntimeStorage(context);
  if (coordination.rootPresence() !== 'absent') return busyStatus(context);
  return completedStatus(
    inspected,
    {
      activeReaders: 0,
      writerPending: false,
      busy: false,
    },
    false,
  );
}

type StatusLeaseAcquisition =
  { readonly status: RuntimeStatusResult } | { readonly lease: RuntimeReadLease };

async function acquireInspectedStatusLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<StatusLeaseAcquisition> {
  const before = await inspectCoordination(coordination, context.project.projectRoot);
  if (before === undefined) return { status: busyStatus(context) };
  const blockedBefore = blockingStatus(context, before, false);
  if (blockedBefore !== undefined) return { status: blockedBefore };

  try {
    return {
      lease: await coordination.acquireRead(context.project.projectRoot),
    };
  } catch (error) {
    if (!isBoundedCoordinationFailure(error)) throw error;
    const raced = await inspectCoordination(coordination, context.project.projectRoot);
    if (raced === undefined) return { status: busyStatus(context) };
    const blocked = blockingStatus(context, raced, false);
    return {
      status:
        blocked ??
        busyStatus(
          context,
          raced.status === 'stable' ? leaseActivity(raced, false, true) : undefined,
        ),
    };
  }
}

async function statusWithLease(
  input: ExecuteRuntimeStatusInput,
  initialContext: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
  lease: RuntimeReadLease,
): Promise<RuntimeStatusResult> {
  let leasedContext = initialContext;
  try {
    // Init may have committed a config while status waited to register.
    // Rebuild storage selection only after the reader is live, and prove that
    // this lease still protects the newly resolved root before any tree read.
    leasedContext = buildRuntimeStatusContext(input, false);
    const result =
      lease.coordinationKey === leasedContext.coordinationKey
        ? await inspectRuntimeStorageUnderLease(leasedContext, coordination)
        : busyStatus(leasedContext);
    return releaseStatusLease(lease) ? result : busyStatus(leasedContext);
  } catch (error) {
    if (!releaseStatusLease(lease)) return busyStatus(leasedContext);
    throw error;
  }
}

/**
 * Inspect the current project's cache/project storage without creating or
 * opening any state.
 */
export async function executeRuntimeStatus(
  input: ExecuteRuntimeStatusInput,
): Promise<RuntimeStatusResult> {
  const context = buildRuntimeStatusContext(input);
  const coordination = resolveStatusCoordination(input.coordination);
  const rootPresence = coordination.rootPresence();

  if (rootPresence === 'unsafe') return busyStatus(context);
  if (rootPresence === 'absent') return statusWithoutCoordination(context, coordination);

  const acquisition = await acquireInspectedStatusLease(context, coordination);
  if ('status' in acquisition) return acquisition.status;
  return statusWithLease(input, context, coordination, acquisition.lease);
}
