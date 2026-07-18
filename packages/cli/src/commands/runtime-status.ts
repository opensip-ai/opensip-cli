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

import {
  currentRuntimePromotionMarkerMatches,
  readRuntimePromotionMarkerRecord,
} from './init/runtime-promotion-marker.js';
import {
  inspectRuntimePromotionStatus,
  type RuntimePromotionStatusInspection,
} from './init/runtime-promotion-status.js';

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

type RuntimeCacheSource =
  | { readonly status: 'none' }
  | { readonly status: 'blocked' }
  | {
      readonly status: 'eligible';
      readonly identityStrength: RuntimeCacheLocationProjection['identityStrength'];
    };

interface InspectedCacheCandidates {
  readonly display: EphemeralRuntimeCandidate;
  readonly displayInspection: RuntimePathInspection;
  readonly activeInspection: RuntimePathInspection;
  readonly multiple: boolean;
  readonly source: RuntimeCacheSource;
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

function inspectCacheCandidates(
  active: EphemeralRuntimeCandidate,
  legacy: EphemeralRuntimeCandidate | undefined,
  projectRoot: string,
): InspectedCacheCandidates {
  const cacheAnchor = resolveUserPaths().userHomeDir;
  const activeInspection = inspectRuntimePath(cacheAnchor, active.runtimeDir);
  const legacyInspection =
    legacy === undefined ? undefined : inspectRuntimePath(cacheAnchor, legacy.runtimeDir);
  const present = [
    ...(active.exists ? [{ candidate: active, inspection: activeInspection }] : []),
    ...(legacy?.exists === true && legacyInspection !== undefined
      ? [{ candidate: legacy, inspection: legacyInspection }]
      : []),
  ];
  const display =
    active.exists || legacy === undefined
      ? { candidate: active, inspection: activeInspection }
      : { candidate: legacy, inspection: legacyInspection ?? 'missing' };
  const selected = present.length === 1 ? present[0] : undefined;
  const authoritativeMarker =
    selected?.inspection === 'trusted'
      ? readRuntimePromotionMarkerRecord(selected.candidate.runtimeDir)
      : undefined;
  let source: RuntimeCacheSource;
  if (present.length === 0) {
    source = { status: 'none' };
  } else if (
    selected?.inspection !== 'trusted' ||
    authoritativeMarker?.marker.marker.projectDir !== projectRoot
  ) {
    source = { status: 'blocked' };
  } else {
    const exactCurrent =
      selected.candidate.kind === 'active' &&
      authoritativeMarker.marker.kind === 'current' &&
      currentRuntimePromotionMarkerMatches(
        authoritativeMarker.marker.marker,
        resolveEphemeralProjectPaths(projectRoot),
      );
    source = {
      status: 'eligible',
      identityStrength: exactCurrent
        ? authoritativeMarker.marker.marker.identityStrength
        : 'legacy-unverified',
    };
  }
  return {
    display: display.candidate,
    displayInspection: display.inspection,
    activeInspection,
    multiple: present.length > 1,
    source,
  };
}

function cacheProjection(
  candidate: EphemeralRuntimeCandidate,
  multiple: boolean,
  inspection: RuntimePathInspection,
  markerBoundToProject: boolean,
  limits: RuntimeSizeLimits,
): RuntimeCacheLocationProjection {
  const location = locationProjection(candidate.runtimeDir, inspection, limits);
  const unsafe = inspection === 'unsafe';
  return {
    ...location,
    identityStrength:
      multiple || unsafe || (location.exists && !markerBoundToProject)
        ? 'legacy-unverified'
        : candidate.identityStrength,
    ...(unsafe || !markerBoundToProject || markerLastUsedAt(candidate) === undefined
      ? {}
      : { lastUsedAt: markerLastUsedAt(candidate) }),
  };
}

function adoptionState(input: {
  readonly source: RuntimeCacheSource;
  readonly projectDestination: 'absent' | 'trusted' | 'unsafe';
}): Exclude<RuntimeAdoptionState, 'busy' | 'recovery-required'> {
  if (input.source.status === 'blocked' || input.projectDestination === 'unsafe') {
    return 'conflict';
  }
  if (input.source.status !== 'eligible') return 'not-needed';
  const weak = input.source.identityStrength !== 'generation-bound';
  if (input.projectDestination === 'trusted') return weak ? 'legacy-unverified' : 'conflict';
  return weak ? 'legacy-unverified' : 'ready';
}

function projectDestination(
  inspection: RuntimePathInspection,
  locationExists: boolean,
): 'absent' | 'trusted' | 'unsafe' {
  if (inspection === 'unsafe') return 'unsafe';
  if (locationExists) return 'trusted';
  return 'absent';
}

function activePlane(projectInitialized: boolean, activeCacheExists: boolean): RuntimeStoragePlane {
  if (projectInitialized) return 'project';
  return activeCacheExists ? 'cache' : 'none';
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
  readonly adoptionBlocked: boolean;
  readonly projectLocationExists: boolean;
  readonly projectDestinationTrusted: boolean;
  readonly evidenceExists: boolean;
  readonly source: RuntimeCacheSource;
}): readonly RuntimeNextCommand[] {
  const commands: RuntimeNextCommand[] = [];
  if (!input.adoptionBlocked) {
    if (input.source.status === 'eligible') {
      if (input.projectDestinationTrusted) {
        commands.push(
          'opensip init --runtime-conflict keep-project',
          'opensip init --runtime-conflict use-cache',
        );
      } else if (input.source.identityStrength === 'generation-bound') {
        commands.push('opensip init');
      } else {
        commands.push('opensip init --runtime-conflict use-cache');
      }
    } else if (!input.initialized) {
      commands.push('opensip init');
    }
  }
  if (input.evidenceExists) {
    commands.push('opensip runs list --json', 'opensip sessions list --json');
  }
  if (input.initialized || input.projectLocationExists) {
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

function resolveStatusCoordination(
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

function leaseBlockingStatus(
  context: RuntimeStatusContext,
  inspection: RuntimeLeaseStateInspection,
  includesStatusReader: boolean,
): RuntimeStatusResult | undefined {
  if (inspection.status === 'busy') return busyStatus(context);
  const activity = leaseActivity(inspection, includesStatusReader, true);
  if (
    inspection.userUninstall.status === 'malformed' ||
    (inspection.userUninstall.status === 'valid' && inspection.userUninstall.state === 'open') ||
    activity.writerPending
  ) {
    return busyStatus(context, activity);
  }
}

function promotionMatchesLeaseInspection(
  promotion: RuntimePromotionStatusInspection,
  inspection: StableLeaseInspection,
): boolean {
  if (promotion.status === 'absent') return inspection.promotion.status === 'absent';
  if (promotion.status === 'cleanup-pending') {
    return inspection.promotion.status === 'valid' && inspection.promotion.state === 'closed';
  }
  if (promotion.status === 'busy') return false;
  if (inspection.promotion.status === 'valid') return inspection.promotion.state === 'open';
  return inspection.promotion.status === 'malformed';
}

function samePromotionProjection(
  left: RuntimePromotionStatusInspection,
  right: RuntimePromotionStatusInspection,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'absent' || left.status === 'busy') return true;
  if (right.status === 'absent' || right.status === 'busy') return false;
  return (
    left.recoveryPhase === right.recoveryPhase &&
    left.recoveryReasonCode === right.recoveryReasonCode &&
    left.recoveryCommand === right.recoveryCommand &&
    (left.status !== 'cleanup-pending' ||
      (right.status === 'cleanup-pending' && left.sourcePreserved === right.sourcePreserved))
  );
}

function inspectPromotion(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): RuntimePromotionStatusInspection | undefined {
  try {
    return coordination.inspectPromotion(context.project.projectRoot, context.coordinationKey);
  } catch (error) {
    if (isBoundedCoordinationFailure(error)) return;
    throw error;
  }
}

function promotionBlockingStatus(
  context: RuntimeStatusContext,
  inspection: StableLeaseInspection,
  projection: RuntimePromotionStatusInspection,
  includesStatusReader: boolean,
): RuntimeStatusResult | undefined {
  if (!promotionMatchesLeaseInspection(projection, inspection)) return busyStatus(context);
  if (projection.status === 'busy') return busyStatus(context);
  if (projection.status === 'recovery-required') {
    return recoveryStatus(
      context,
      projection,
      leaseActivity(inspection, includesStatusReader, true),
    );
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
  const inspectedCache = inspectCacheCandidates(
    candidates.active,
    candidates.legacy,
    project.projectRoot,
  );
  const projectInspection = inspectRuntimePath(project.projectRoot, projectPaths.runtimeDir);
  const cache = cacheProjection(
    inspectedCache.display,
    inspectedCache.multiple,
    inspectedCache.displayInspection,
    inspectedCache.source.status === 'eligible',
    limits,
  );
  const projectLocation = locationProjection(projectPaths.runtimeDir, projectInspection, limits);
  const destination = projectDestination(projectInspection, projectLocation.exists);
  const plane = activePlane(projectInitialized, candidates.active.exists);
  const selectedRuntime = selectedRuntimeDir({
    plane,
    projectRuntimeDir: projectPaths.runtimeDir,
    cacheRuntimeDir: candidates.active.runtimeDir,
  });
  const evidencePath =
    selectedRuntime === undefined ? undefined : join(selectedRuntime, DATASTORE_FILE);
  const selectedInspection = selectedRuntimeInspection({
    plane,
    project: projectInspection,
    cache: inspectedCache.activeInspection,
  });
  const evidenceDatabase =
    selectedInspection === 'trusted'
      ? evidenceDatabaseProjection(evidencePath)
      : ({ exists: false } as const);
  const state = adoptionState({
    source: inspectedCache.source,
    projectDestination: destination,
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
      adoptionBlocked: inspectedCache.source.status === 'blocked' || destination === 'unsafe',
      projectLocationExists: projectLocation.exists,
      projectDestinationTrusted: destination === 'trusted',
      evidenceExists: evidenceDatabase.exists,
      source: inspectedCache.source,
    }),
  };
}

type InspectedRuntimeStatus = ReturnType<typeof inspectRuntimeStorage>;

function completedStatus(
  inspected: InspectedRuntimeStatus,
  activity: RuntimeLeaseActivity,
  promotion: Extract<
    RuntimePromotionStatusInspection,
    { readonly status: 'absent' | 'cleanup-pending' }
  >,
): RuntimeStatusResult {
  if (promotion.status === 'cleanup-pending') {
    return {
      ...inspected,
      leaseActivity: activity,
      recoveryPhase: promotion.recoveryPhase,
      recoveryReasonCode: promotion.recoveryReasonCode,
      ...(promotion.sourcePreserved === undefined
        ? {}
        : { sourcePreserved: promotion.sourcePreserved }),
      cleanupPending: true,
      recoveryCommand: promotion.recoveryCommand,
      nextCommands: [
        promotion.recoveryCommand,
        ...inspected.nextCommands.filter((command) => command !== promotion.recoveryCommand),
      ],
    };
  }
  return { ...inspected, leaseActivity: activity };
}

async function inspectRuntimeStorageUnderLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<RuntimeStatusResult> {
  const underLease = await inspectCoordination(coordination, context.project.projectRoot);
  if (underLease === undefined) return busyStatus(context);
  const blockedUnderLease = leaseBlockingStatus(context, underLease, true);
  if (blockedUnderLease !== undefined) return blockedUnderLease;
  if (underLease.status !== 'stable' || underLease.projectReaders < 1) {
    return busyStatus(context);
  }
  const initialPromotion = inspectPromotion(context, coordination);
  if (initialPromotion === undefined) return busyStatus(context);
  const promotionBlocked = promotionBlockingStatus(context, underLease, initialPromotion, true);
  if (promotionBlocked !== undefined) return promotionBlocked;

  const inspected = inspectRuntimeStorage(context);
  const finalInspection = await inspectCoordination(coordination, context.project.projectRoot);
  if (finalInspection === undefined) return busyStatus(context);
  const blockedAfterRead = leaseBlockingStatus(context, finalInspection, true);
  if (blockedAfterRead !== undefined) return blockedAfterRead;
  if (finalInspection.status !== 'stable' || finalInspection.projectReaders < 1) {
    return busyStatus(context);
  }
  const finalPromotion = inspectPromotion(context, coordination);
  if (finalPromotion === undefined) return busyStatus(context);
  const finalPromotionBlocked = promotionBlockingStatus(
    context,
    finalInspection,
    finalPromotion,
    true,
  );
  if (finalPromotionBlocked !== undefined) return finalPromotionBlocked;
  if (finalPromotion.status === 'busy' || finalPromotion.status === 'recovery-required') {
    return busyStatus(context);
  }

  return completedStatus(inspected, leaseActivity(finalInspection, true, false), finalPromotion);
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
    { status: 'absent' },
  );
}

type StatusLeaseAcquisition =
  { readonly status: RuntimeStatusResult } | { readonly lease: RuntimeReadLease };

async function promotionProjectionRemainedStable(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
  promotion: RuntimePromotionStatusInspection,
): Promise<boolean> {
  const afterProjection = await inspectCoordination(coordination, context.project.projectRoot);
  if (
    afterProjection?.status !== 'stable' ||
    leaseBlockingStatus(context, afterProjection, false) !== undefined ||
    !promotionMatchesLeaseInspection(promotion, afterProjection)
  ) {
    return false;
  }
  const afterPromotion = inspectPromotion(context, coordination);
  return afterPromotion !== undefined && samePromotionProjection(promotion, afterPromotion);
}

async function acquireInspectedStatusLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<StatusLeaseAcquisition> {
  const before = await inspectCoordination(coordination, context.project.projectRoot);
  if (before === undefined) return { status: busyStatus(context) };
  const blockedBefore = leaseBlockingStatus(context, before, false);
  if (blockedBefore !== undefined) return { status: blockedBefore };
  if (before.status !== 'stable') return { status: busyStatus(context) };

  const promotion = inspectPromotion(context, coordination);
  if (promotion === undefined) return { status: busyStatus(context) };
  const promotionBlocked = promotionBlockingStatus(context, before, promotion, false);
  if (promotionBlocked !== undefined) {
    if (!(await promotionProjectionRemainedStable(context, coordination, promotion))) {
      return { status: busyStatus(context) };
    }
    return { status: promotionBlocked };
  }

  try {
    return {
      lease: await coordination.acquireRead(context.project.projectRoot),
    };
  } catch (error) {
    if (!isBoundedCoordinationFailure(error)) throw error;
    const raced = await inspectCoordination(coordination, context.project.projectRoot);
    if (raced === undefined) return { status: busyStatus(context) };
    const blocked = leaseBlockingStatus(context, raced, false);
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
