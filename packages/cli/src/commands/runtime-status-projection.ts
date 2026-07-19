import { join } from 'node:path';

import {
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  inspectEphemeralRuntimeCandidates,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralRuntimeCandidate,
  type ProjectContext,
} from '@opensip-cli/core';

import {
  currentRuntimePromotionMarkerMatches,
  readRuntimePromotionMarkerRecord,
} from './init/runtime-promotion-marker.js';
import {
  evidenceDatabaseProjection,
  inspectRuntimePath,
  locationProjection,
  type RuntimePathInspection,
  type RuntimeStatusSizeLimits,
} from './runtime-status-filesystem.js';

import type { SessionRetentionPolicy } from '../bootstrap/session-retention.js';
import type { RuntimePromotionStatusInspection } from './init/runtime-promotion-status.js';
import type {
  RuntimeAdoptionState,
  RuntimeCacheLocationProjection,
  RuntimeLeaseActivity,
  RuntimeNextCommand,
  RuntimeStatusResult,
  RuntimeStoragePlane,
} from '@opensip-cli/contracts';

const DATASTORE_FILE = 'datastore.sqlite';

export interface RuntimeStorageProjectionContext {
  readonly project: ProjectContext;
  readonly limits: RuntimeStatusSizeLimits;
  readonly projectInitialized: boolean;
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
  limits: RuntimeStatusSizeLimits,
): RuntimeCacheLocationProjection {
  const location = locationProjection(candidate.runtimeDir, inspection, limits);
  const unsafe = inspection === 'unsafe';
  const lastUsedAt = markerLastUsedAt(candidate);
  return {
    ...location,
    identityStrength:
      multiple || unsafe || (location.exists && !markerBoundToProject)
        ? 'legacy-unverified'
        : candidate.identityStrength,
    ...(unsafe || !markerBoundToProject || lastUsedAt === undefined ? {} : { lastUsedAt }),
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
  if (!input.adoptionBlocked) {
    commands.push('opensip uninstall --user --dry-run');
  }
  return commands;
}

/** Inspect the selected cache/project storage without opening persisted evidence. */
export function inspectRuntimeStorage(context: RuntimeStorageProjectionContext) {
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

export type InspectedRuntimeStatus = ReturnType<typeof inspectRuntimeStorage>;

/** Add stable lease/promotion evidence to a completed storage projection. */
export function completedStatus(
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
