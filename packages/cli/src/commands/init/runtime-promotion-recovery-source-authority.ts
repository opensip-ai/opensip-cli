import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  EPHEMERAL_MARKER_FILE,
  EPHEMERAL_MARKER_MAX_BYTES,
  projectCoordinationKey,
  readAnchoredRecord,
  resolveUserPaths,
  type EphemeralMarker,
  type RuntimeExclusiveLease,
} from '@opensip-cli/core';

import {
  assertStablePromotionDirectory,
  closeStablePromotionDirectory,
  openStablePromotionDirectory,
  type StablePromotionDirectory,
} from './runtime-promotion-filesystem-io.js';
import {
  RUNTIME_PROMOTION_CACHE_KEY_PATTERN,
  RUNTIME_PROMOTION_DIGEST_PATTERN,
  type RuntimePromotionSource,
} from './runtime-promotion-journal-schema.js';
import { parseRuntimePromotionMarker } from './runtime-promotion-marker.js';
import {
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
} from './runtime-promotion-path-snapshot.js';
import { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';

const GENERATION_BOUND = 'generation-bound' as const;
const OWNER_CONTROLLED = 'owner-controlled' as const;

export interface RuntimePromotionPreflightFsDependencies {
  readonly afterCandidateResolution?: () => void;
  readonly afterMarkerRead?: () => void;
}

export interface RuntimePromotionRecoverySourceAuthorityInput {
  /** Already-selected canonical project root; aliases and replacements fail closed. */
  readonly projectRoot: string;
  /** Exact canonical cache path derived from the validated journal cache key. */
  readonly sourceRuntime: string;
  readonly source: RuntimePromotionSource;
  readonly lease: RuntimeExclusiveLease;
}

/** @throws {RuntimePromotionPreflightError} Always; the recorded source authority changed. */
function recoverySourceChanged(): never {
  throw new RuntimePromotionPreflightError('changed-after-preflight');
}

export interface RuntimePromotionCanonicalCacheChild {
  readonly cacheRoot: string;
  readonly runtimeDir: string;
}

export interface RuntimePromotionBoundCacheChild extends RuntimePromotionCanonicalCacheChild {
  readonly rootIdentity: {
    readonly device: string;
    readonly inode: string;
  };
}

/**
 * Resolve a cache-key child from the canonical cache root without following the
 * selected leaf.
 */
export function canonicalRuntimePromotionCacheChild(
  cacheRootInput: string,
  cacheKey: string,
): RuntimePromotionCanonicalCacheChild {
  if (!RUNTIME_PROMOTION_CACHE_KEY_PATTERN.test(cacheKey)) recoverySourceChanged();
  let cacheRoot: string;
  try {
    cacheRoot = realpathSync(cacheRootInput);
  } catch {
    recoverySourceChanged();
  }
  if (runtimePromotionPathSnapshot(cacheRoot).presence !== 'directory') {
    recoverySourceChanged();
  }
  return {
    cacheRoot,
    runtimeDir: join(cacheRoot, cacheKey),
  };
}

/**
 * Bind an existing exact cache-key child to a stable directory object.
 *
 * @throws {RuntimePromotionPreflightError} When the canonical cache child
 *   cannot be pinned to a stable exact identity.
 */
export function bindRuntimePromotionCacheChild(
  cacheRootInput: string,
  cacheKey: string,
): RuntimePromotionBoundCacheChild {
  const canonical = canonicalRuntimePromotionCacheChild(cacheRootInput, cacheKey);
  let root: StablePromotionDirectory | undefined;
  let child: StablePromotionDirectory | undefined;
  try {
    root = openStablePromotionDirectory(canonical.cacheRoot, 'the OpenSIP cache root');
    if (root.path !== canonical.cacheRoot) recoverySourceChanged();
    const exactChild = join(root.path, cacheKey);
    if (dirname(exactChild) !== root.path || basename(exactChild) !== cacheKey) {
      recoverySourceChanged();
    }
    child = openStablePromotionDirectory(exactChild, 'the selected OpenSIP cache runtime');
    if (
      child.path !== exactChild ||
      dirname(child.path) !== root.path ||
      basename(child.path) !== cacheKey
    ) {
      recoverySourceChanged();
    }
    assertStablePromotionDirectory(root, 'the OpenSIP cache root');
    assertStablePromotionDirectory(child, 'the selected OpenSIP cache runtime');
    return {
      cacheRoot: root.path,
      runtimeDir: child.path,
      rootIdentity: {
        device: child.identity.dev.toString(),
        inode: child.identity.ino.toString(),
      },
    };
  } catch {
    return recoverySourceChanged();
  } finally {
    if (child !== undefined) closeStablePromotionDirectory(child);
    if (root !== undefined) closeStablePromotionDirectory(root);
  }
}

function recoverySourceShapeValid(source: RuntimePromotionSource): boolean {
  if (
    source.classification === 'none' ||
    source.cacheKey === null ||
    source.markerSha256 === null ||
    source.rootIdentity === null ||
    !RUNTIME_PROMOTION_CACHE_KEY_PATTERN.test(source.cacheKey) ||
    !RUNTIME_PROMOTION_DIGEST_PATTERN.test(source.markerSha256)
  ) {
    return false;
  }
  return source.classification === GENERATION_BOUND
    ? source.generationDigest !== null &&
        RUNTIME_PROMOTION_DIGEST_PATTERN.test(source.generationDigest)
    : source.generationDigest === null;
}

function recoveryMarkerRead(
  cacheRoot: string,
  sourceRuntime: string,
): {
  readonly content: string;
  readonly sha256: string;
} {
  let observed;
  try {
    observed = readAnchoredRecord({
      trustedAnchorDir: cacheRoot,
      parentDir: sourceRuntime,
      basename: EPHEMERAL_MARKER_FILE,
      maxBytes: EPHEMERAL_MARKER_MAX_BYTES,
      permissionPosture: OWNER_CONTROLLED,
      recordPosture: OWNER_CONTROLLED,
    });
  } catch {
    recoverySourceChanged();
  }
  if (observed.status !== 'present') recoverySourceChanged();
  return observed;
}

function expectedGenerationCacheKey(canonicalRootDigest: string, generationDigest: string): string {
  return createHash('sha256')
    .update(`opensip-ephemeral-cache-v2\0${canonicalRootDigest}\0${generationDigest}`)
    .digest('hex')
    .slice(0, 24);
}

function currentRecoveryMarkerMatches(input: {
  readonly projectRoot: string;
  readonly cacheKey: string;
  readonly source: RuntimePromotionSource;
  readonly marker: EphemeralMarker;
}): boolean {
  const canonicalRootDigest = createHash('sha256').update(input.projectRoot).digest('hex');
  if (
    input.marker.projectDir !== input.projectRoot ||
    input.marker.canonicalRootDigest !== canonicalRootDigest ||
    input.marker.identityStrength !== input.source.classification
  ) {
    return false;
  }
  if (input.source.classification === 'path-only') {
    return (
      input.marker.generationDigest === undefined &&
      input.source.generationDigest === null &&
      input.cacheKey === canonicalRootDigest.slice(0, 24)
    );
  }
  if (input.source.classification !== GENERATION_BOUND || input.source.generationDigest === null) {
    return false;
  }
  return (
    input.marker.generationDigest === input.source.generationDigest &&
    input.cacheKey ===
      expectedGenerationCacheKey(canonicalRootDigest, input.source.generationDigest)
  );
}

/**
 * Validate only the canonical location/type needed by monotonic closed cleanup.
 *
 * @throws {RuntimePromotionPreflightError} When source or lease authority
 *   cannot be revalidated.
 */
export function assertRuntimePromotionRecoverySourceLocation(
  input: RuntimePromotionRecoverySourceAuthorityInput,
): void {
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(input.projectRoot);
  } catch {
    recoverySourceChanged();
  }
  if (
    canonicalProjectRoot !== input.projectRoot ||
    runtimePromotionPathSnapshot(input.projectRoot).presence !== 'directory'
  ) {
    recoverySourceChanged();
  }
  if (
    input.lease.kind !== 'runtime-exclusive' ||
    input.lease.posture !== 'init-recovery' ||
    input.lease.coordinationKey !== projectCoordinationKey(input.projectRoot)
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
  const source: RuntimePromotionSource = {
    classification: input.source.classification,
    cacheKey: input.source.cacheKey,
    generationDigest: input.source.generationDigest,
    markerSha256: input.source.markerSha256,
    rootIdentity: input.source.rootIdentity,
  };
  if (!recoverySourceShapeValid(source) || source.cacheKey === null) recoverySourceChanged();
  const canonical = bindRuntimePromotionCacheChild(
    resolveUserPaths().ephemeralProjectsDir,
    source.cacheKey,
  );
  if (input.sourceRuntime !== canonical.runtimeDir) recoverySourceChanged();
  const rootBefore = runtimePromotionPathSnapshot(canonical.cacheRoot);
  const sourceBefore = runtimePromotionPathSnapshot(canonical.runtimeDir);
  const sourceAfter = runtimePromotionPathSnapshot(canonical.runtimeDir);
  const rootAfter = runtimePromotionPathSnapshot(canonical.cacheRoot);
  if (
    rootBefore.presence !== 'directory' ||
    sourceBefore.presence !== 'directory' ||
    canonical.rootIdentity.device !== source.rootIdentity?.device ||
    canonical.rootIdentity.inode !== source.rootIdentity?.inode ||
    !sameRuntimePromotionPathSnapshot(rootBefore, rootAfter) ||
    !sameRuntimePromotionPathSnapshot(sourceBefore, sourceAfter)
  ) {
    recoverySourceChanged();
  }
}

/**
 * Revalidate the cache-source authority recorded by an existing journal.
 *
 * @throws {RuntimePromotionPreflightError} When source, marker, or lease
 *   authority changes during the bounded proof.
 */
export function assertRuntimePromotionRecoverySourceAuthority(
  input: RuntimePromotionRecoverySourceAuthorityInput,
  dependencies: Pick<RuntimePromotionPreflightFsDependencies, 'afterMarkerRead'> = {},
): void {
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(input.projectRoot);
  } catch {
    recoverySourceChanged();
  }
  if (
    canonicalProjectRoot !== input.projectRoot ||
    runtimePromotionPathSnapshot(input.projectRoot).presence !== 'directory'
  ) {
    recoverySourceChanged();
  }
  if (
    input.lease.kind !== 'runtime-exclusive' ||
    input.lease.posture !== 'init-recovery' ||
    input.lease.coordinationKey !== projectCoordinationKey(input.projectRoot)
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
  const source: RuntimePromotionSource = {
    classification: input.source.classification,
    cacheKey: input.source.cacheKey,
    generationDigest: input.source.generationDigest,
    markerSha256: input.source.markerSha256,
    rootIdentity: input.source.rootIdentity,
  };
  if (!recoverySourceShapeValid(source)) recoverySourceChanged();
  const cacheKey = source.cacheKey;
  const markerSha256 = source.markerSha256;
  if (cacheKey === null || markerSha256 === null) recoverySourceChanged();
  const canonical = bindRuntimePromotionCacheChild(
    resolveUserPaths().ephemeralProjectsDir,
    cacheKey,
  );
  if (input.sourceRuntime !== canonical.runtimeDir) recoverySourceChanged();
  if (
    source.rootIdentity?.device !== canonical.rootIdentity.device ||
    source.rootIdentity?.inode !== canonical.rootIdentity.inode
  ) {
    recoverySourceChanged();
  }

  const before = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (before.presence !== 'directory') recoverySourceChanged();
  const firstMarker = recoveryMarkerRead(canonical.cacheRoot, canonical.runtimeDir);
  dependencies.afterMarkerRead?.();
  const afterFirstRead = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(before, afterFirstRead)) recoverySourceChanged();
  const confirmedMarker = recoveryMarkerRead(canonical.cacheRoot, canonical.runtimeDir);
  const afterConfirmation = runtimePromotionPathSnapshot(canonical.runtimeDir);
  if (!sameRuntimePromotionPathSnapshot(before, afterConfirmation)) recoverySourceChanged();
  if (
    firstMarker.sha256 !== markerSha256 ||
    confirmedMarker.sha256 !== markerSha256 ||
    firstMarker.content !== confirmedMarker.content
  ) {
    recoverySourceChanged();
  }
  const marker = parseRuntimePromotionMarker(confirmedMarker.content);
  if (marker?.marker.projectDir !== input.projectRoot) recoverySourceChanged();
  if (
    source.classification !== 'legacy' &&
    (marker.kind !== 'current' ||
      !currentRecoveryMarkerMatches({
        projectRoot: input.projectRoot,
        cacheKey,
        source,
        marker: marker.marker,
      }))
  ) {
    recoverySourceChanged();
  }
}

export class RuntimePromotionFilesystemLeaseMismatchError extends Error {
  constructor() {
    super('Runtime promotion filesystem inspection requires the matching exclusive lease');
    this.name = 'RuntimePromotionFilesystemLeaseMismatchError';
  }
}
