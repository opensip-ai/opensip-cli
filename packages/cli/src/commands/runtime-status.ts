/**
 * Read-only projection of the current project's local OpenSIP storage.
 *
 * This module deliberately uses filesystem metadata only. It never opens
 * SQLite, touches cache markers, creates a runtime, or prunes another entry.
 */

import { lstatSync, opendirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  DEFAULT_EPHEMERAL_KEEP,
  DEFAULT_EPHEMERAL_MAX_AGE_DAYS,
  inspectEphemeralRuntimeCandidates,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralRuntimeCandidate,
  type ProjectContext,
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
  RuntimeLocationProjection,
  RuntimeNextCommand,
  RuntimeStatusResult,
  RuntimeStoragePlane,
} from '@opensip-cli/contracts';

const DATASTORE_FILE = 'datastore.sqlite';

/** A status read is bounded even when the runtime contains hostile content. */
export const RUNTIME_STATUS_MAX_ENTRIES = 10_000;
export const RUNTIME_STATUS_MAX_BYTES = 1024 * 1024 * 1024;

interface RuntimeSizeLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface ExecuteRuntimeStatusInput {
  readonly cwd: string;
  readonly cwdExplicit: boolean;
  /** Preserve bootstrap's explicit-config authority when it is available. */
  readonly projectContext?: ProjectContext;
  /** Test seam for proving traversal caps without creating a huge fixture. */
  readonly sizeLimits?: Partial<RuntimeSizeLimits>;
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
  if (
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`)
  ) {
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

function activePlane(
  projectInitialized: boolean,
  cacheExists: boolean,
): RuntimeStoragePlane {
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

/**
 * Inspect the current project's cache/project storage without creating or
 * opening any state.
 */
export function executeRuntimeStatus(input: ExecuteRuntimeStatusInput): RuntimeStatusResult {
  const project =
    input.projectContext ??
    resolveProjectContext({
      cwd: input.cwd,
      cwdExplicit: input.cwdExplicit,
    });
  const limits: RuntimeSizeLimits = {
    maxEntries: input.sizeLimits?.maxEntries ?? RUNTIME_STATUS_MAX_ENTRIES,
    maxBytes: input.sizeLimits?.maxBytes ?? RUNTIME_STATUS_MAX_BYTES,
  };
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
  const projectLocation = locationProjection(
    projectPaths.runtimeDir,
    projectInspection,
    limits,
  );
  const projectInitialized =
    project.scope === 'project' &&
    project.configPath !== undefined &&
    safePathExists(project.configPath);
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
  const retention = effectiveEvidenceRetention(project);

  return {
    type: 'runtime-status',
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
      evidence: retention,
    },
    nextCommands: nextCommands({
      initialized: projectInitialized,
      projectRuntimeExists: projectLocation.exists,
      evidenceExists: evidenceDatabase.exists,
      adoptionState: state,
    }),
  };
}
