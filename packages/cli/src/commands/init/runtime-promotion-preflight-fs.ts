import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  EPHEMERAL_MARKER_VERSION,
  legacyEphemeralProjectCacheKey,
  readAnchoredRecord,
  resolveEphemeralProjectPaths,
  resolveProjectPaths,
  resolveUserPaths,
  type EphemeralMarker,
  type EphemeralProjectPaths,
  type LegacyEphemeralMarker,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import type { RuntimePromotionSource } from './runtime-promotion-journal-schema.js';

export type RuntimePromotionPathPresence = 'absent' | 'directory' | 'unsafe';

export interface RuntimePromotionPathIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly uid: string;
  readonly mode: string;
  readonly nlink: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface RuntimePromotionPathSnapshot {
  readonly presence: RuntimePromotionPathPresence;
  readonly identity?: RuntimePromotionPathIdentity;
}

export interface RuntimePromotionSourceRevalidation {
  readonly kind: 'active' | 'legacy';
  readonly runtimeDir: string;
  readonly cacheKey: string;
  readonly markerSha256: string;
  readonly runtime: RuntimePromotionPathSnapshot;
}

export interface RuntimePromotionFilesystemInspection {
  readonly projectRoot: string;
  readonly ephemeral: Pick<
    EphemeralProjectPaths,
    'cacheKey' | 'coordinationKey' | 'identityStrength' | 'canonicalRootDigest' | 'generationDigest'
  >;
  readonly projectRootSnapshot: RuntimePromotionPathSnapshot;
  readonly activeCandidateDir: string;
  readonly activeCandidate: RuntimePromotionPathSnapshot;
  readonly legacyCandidateDir?: string;
  readonly legacyCandidate?: RuntimePromotionPathSnapshot;
  readonly destinationParentDir: string;
  readonly destinationRuntimeDir: string;
  readonly destinationParent: RuntimePromotionPathSnapshot;
  readonly destinationRuntime: RuntimePromotionPathSnapshot;
  readonly source: RuntimePromotionSource;
  readonly sourceRevalidation?: RuntimePromotionSourceRevalidation;
}

export type RuntimePromotionFilesystemConflictReason =
  | 'cache-candidates-ambiguous'
  | 'cache-marker-invalid'
  | 'cache-path-unsafe'
  | 'project-path-unsafe';

export type RuntimePromotionFilesystemInspectionResult =
  | {
      readonly status: 'ready';
      readonly inspection: RuntimePromotionFilesystemInspection;
    }
  | {
      readonly status: 'conflict';
      readonly reason: RuntimePromotionFilesystemConflictReason;
      readonly sourcePreserved: boolean;
    };

type ParsedMarker =
  | { readonly kind: 'current'; readonly marker: EphemeralMarker }
  | { readonly kind: 'legacy'; readonly marker: LegacyEphemeralMarker };

const PROJECT_PATH_UNSAFE = 'project-path-unsafe' as const;

export interface RuntimePromotionPreflightFsDependencies {
  readonly afterCandidateResolution?: () => void;
  readonly afterMarkerRead?: () => void;
}

export class RuntimePromotionFilesystemLeaseMismatchError extends Error {
  constructor() {
    super('Runtime promotion filesystem inspection requires the matching exclusive lease');
    this.name = 'RuntimePromotionFilesystemLeaseMismatchError';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function identity(stat: BigIntStats): RuntimePromotionPathIdentity {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: stat.uid.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameIdentity(
  left: RuntimePromotionPathIdentity | undefined,
  right: RuntimePromotionPathIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function runtimePromotionPathSnapshot(path: string): RuntimePromotionPathSnapshot {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) {
      return { presence: 'unsafe' };
    }
    return { presence: 'directory', identity: identity(stat) };
  } catch (error) {
    return hasCode(error, 'ENOENT') ? { presence: 'absent' } : { presence: 'unsafe' };
  }
}

export function sameRuntimePromotionPathSnapshot(
  left: RuntimePromotionPathSnapshot,
  right: RuntimePromotionPathSnapshot,
): boolean {
  if (left.presence !== right.presence) return false;
  if (left.presence !== 'directory') return true;
  return sameIdentity(left.identity, right.identity);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
}

function parseMarker(raw: string): ParsedMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (record.version === EPHEMERAL_MARKER_VERSION) {
    const identityStrength = record.identityStrength;
    const generationBound = identityStrength === 'generation-bound';
    const expectedKeys = generationBound
      ? [
          'version',
          'projectDir',
          'canonicalRootDigest',
          'identityStrength',
          'generationDigest',
          'lastUsedAt',
        ]
      : ['version', 'projectDir', 'canonicalRootDigest', 'identityStrength', 'lastUsedAt'];
    if (
      !exactKeys(record, expectedKeys) ||
      typeof record.projectDir !== 'string' ||
      !isDigest(record.canonicalRootDigest) ||
      (identityStrength !== 'generation-bound' && identityStrength !== 'path-only') ||
      (generationBound
        ? !isDigest(record.generationDigest)
        : record.generationDigest !== undefined) ||
      !isCanonicalTimestamp(record.lastUsedAt)
    ) {
      return;
    }
    return {
      kind: 'current',
      marker: {
        version: EPHEMERAL_MARKER_VERSION,
        projectDir: record.projectDir,
        canonicalRootDigest: record.canonicalRootDigest,
        identityStrength,
        ...(generationBound ? { generationDigest: record.generationDigest as string } : {}),
        lastUsedAt: record.lastUsedAt,
      },
    };
  }
  if (
    exactKeys(record, ['projectDir', 'lastUsedAt']) &&
    typeof record.projectDir === 'string' &&
    isCanonicalTimestamp(record.lastUsedAt)
  ) {
    return {
      kind: 'legacy',
      marker: {
        projectDir: record.projectDir,
        lastUsedAt: record.lastUsedAt,
      },
    };
  }
}

function currentMarkerMatches(marker: EphemeralMarker, paths: EphemeralProjectPaths): boolean {
  return (
    marker.projectDir === paths.projectDir &&
    marker.canonicalRootDigest === paths.canonicalRootDigest &&
    marker.identityStrength === paths.identityStrength &&
    marker.generationDigest === paths.generationDigest
  );
}

function inspectSource(input: {
  readonly projectRoot: string;
  readonly paths: EphemeralProjectPaths;
  readonly active: RuntimePromotionPathSnapshot;
  readonly legacy: RuntimePromotionPathSnapshot;
  readonly legacyKey: string;
  readonly legacyDir: string;
  readonly dependencies: RuntimePromotionPreflightFsDependencies;
}):
  | {
      readonly status: 'ready';
      readonly source: RuntimePromotionSource;
      readonly revalidation?: RuntimePromotionSourceRevalidation;
    }
  | {
      readonly status: 'conflict';
      readonly reason: RuntimePromotionFilesystemConflictReason;
      readonly sourcePreserved: boolean;
    } {
  const activePresent = input.active.presence !== 'absent';
  const legacyPresent = input.legacy.presence !== 'absent';
  if (activePresent && legacyPresent) {
    return {
      status: 'conflict',
      reason: 'cache-candidates-ambiguous',
      sourcePreserved: true,
    };
  }
  if (!activePresent && !legacyPresent) {
    return {
      status: 'ready',
      source: {
        classification: 'none',
        cacheKey: null,
        generationDigest: null,
        markerSha256: null,
      },
    };
  }

  const selected =
    input.active.presence === 'absent'
      ? {
          kind: 'legacy' as const,
          runtimeDir: input.legacyDir,
          cacheKey: input.legacyKey,
          snapshot: input.legacy,
        }
      : {
          kind: 'active' as const,
          runtimeDir: input.paths.runtimeDir,
          cacheKey: input.paths.cacheKey,
          snapshot: input.active,
        };
  if (selected.snapshot.presence !== 'directory') {
    return { status: 'conflict', reason: 'cache-path-unsafe', sourcePreserved: true };
  }

  let observed;
  try {
    observed = readAnchoredRecord({
      trustedAnchorDir: resolveUserPaths().ephemeralProjectsDir,
      parentDir: selected.runtimeDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: 'owner-controlled',
      recordPosture: 'owner-controlled',
    });
  } catch {
    return { status: 'conflict', reason: 'cache-marker-invalid', sourcePreserved: true };
  }
  input.dependencies.afterMarkerRead?.();
  if (observed.status !== 'present') {
    return { status: 'conflict', reason: 'cache-marker-invalid', sourcePreserved: true };
  }
  const marker = parseMarker(observed.content);
  if (marker?.marker.projectDir !== input.projectRoot) {
    return { status: 'conflict', reason: 'cache-marker-invalid', sourcePreserved: true };
  }
  const runtimeAfter = runtimePromotionPathSnapshot(selected.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(selected.snapshot, runtimeAfter)) {
    return { status: 'conflict', reason: 'cache-path-unsafe', sourcePreserved: true };
  }

  const exactCurrent =
    selected.kind === 'active' &&
    marker.kind === 'current' &&
    currentMarkerMatches(marker.marker, input.paths);
  const classification = exactCurrent ? input.paths.identityStrength : 'legacy';
  return {
    status: 'ready',
    source: {
      classification,
      cacheKey: selected.cacheKey,
      generationDigest:
        classification === 'generation-bound' ? (input.paths.generationDigest ?? null) : null,
      markerSha256: observed.sha256,
    },
    revalidation: {
      kind: selected.kind,
      runtimeDir: selected.runtimeDir,
      cacheKey: selected.cacheKey,
      markerSha256: observed.sha256,
      runtime: runtimeAfter,
    },
  };
}

function leaseMatches(lease: RuntimeExclusiveLease, paths: EphemeralProjectPaths): boolean {
  return (
    lease.kind === 'runtime-exclusive' &&
    lease.posture === 'normal' &&
    lease.coordinationKey === paths.coordinationKey
  );
}

export function inspectRuntimePromotionFilesystem(
  projectRootInput: string,
  lease: RuntimeExclusiveLease,
  dependencies: RuntimePromotionPreflightFsDependencies = {},
): RuntimePromotionFilesystemInspectionResult {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectRootInput);
  } catch {
    return { status: 'conflict', reason: PROJECT_PATH_UNSAFE, sourcePreserved: true };
  }
  const projectRootBefore = runtimePromotionPathSnapshot(projectRoot);
  if (projectRootBefore.presence !== 'directory') {
    return { status: 'conflict', reason: PROJECT_PATH_UNSAFE, sourcePreserved: true };
  }

  let paths: EphemeralProjectPaths;
  try {
    paths = resolveEphemeralProjectPaths(projectRoot);
  } catch {
    return { status: 'conflict', reason: PROJECT_PATH_UNSAFE, sourcePreserved: true };
  }
  if (!leaseMatches(lease, paths)) {
    throw new RuntimePromotionFilesystemLeaseMismatchError();
  }
  const projectPaths = resolveProjectPaths(projectRoot);
  const legacyKey = legacyEphemeralProjectCacheKey(projectRoot);
  const legacyDir = join(resolveUserPaths().ephemeralProjectsDir, legacyKey);
  const active = runtimePromotionPathSnapshot(paths.runtimeDir);
  const legacy =
    legacyKey === paths.cacheKey
      ? ({ presence: 'absent' } as const)
      : runtimePromotionPathSnapshot(legacyDir);
  dependencies.afterCandidateResolution?.();

  const destinationParent = runtimePromotionPathSnapshot(projectPaths.userSourceDir);
  const destinationRuntime = runtimePromotionPathSnapshot(projectPaths.runtimeDir);
  if (
    destinationParent.presence === 'unsafe' ||
    destinationRuntime.presence === 'unsafe' ||
    (destinationParent.presence === 'absent' && destinationRuntime.presence !== 'absent')
  ) {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: active.presence !== 'absent' || legacy.presence !== 'absent',
    };
  }

  const source = inspectSource({
    projectRoot,
    paths,
    active,
    legacy,
    legacyKey,
    legacyDir,
    dependencies,
  });
  if (source.status === 'conflict') return source;

  const projectRootAfter = runtimePromotionPathSnapshot(projectRoot);
  if (!sameRuntimePromotionPathSnapshot(projectRootBefore, projectRootAfter)) {
    return {
      status: 'conflict',
      reason: PROJECT_PATH_UNSAFE,
      sourcePreserved: source.source.classification !== 'none',
    };
  }
  return {
    status: 'ready',
    inspection: {
      projectRoot,
      ephemeral: {
        cacheKey: paths.cacheKey,
        coordinationKey: paths.coordinationKey,
        identityStrength: paths.identityStrength,
        canonicalRootDigest: paths.canonicalRootDigest,
        ...(paths.generationDigest === undefined
          ? {}
          : { generationDigest: paths.generationDigest }),
      },
      projectRootSnapshot: projectRootAfter,
      activeCandidateDir: paths.runtimeDir,
      activeCandidate: active,
      ...(legacyKey === paths.cacheKey
        ? {}
        : { legacyCandidateDir: legacyDir, legacyCandidate: legacy }),
      destinationParentDir: projectPaths.userSourceDir,
      destinationRuntimeDir: projectPaths.runtimeDir,
      destinationParent,
      destinationRuntime,
      source: source.source,
      ...(source.revalidation === undefined ? {} : { sourceRevalidation: source.revalidation }),
    },
  };
}

export function readRuntimePromotionMarkerSha256(
  source: RuntimePromotionSourceRevalidation,
): string | undefined {
  try {
    const observed = readAnchoredRecord({
      trustedAnchorDir: resolveUserPaths().ephemeralProjectsDir,
      parentDir: source.runtimeDir,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: 'owner-controlled',
      recordPosture: 'owner-controlled',
    });
    return observed.status === 'present' ? observed.sha256 : undefined;
  } catch {
    return;
  }
}
