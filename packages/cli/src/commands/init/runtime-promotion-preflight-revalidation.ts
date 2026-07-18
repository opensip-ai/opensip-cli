import { realpathSync } from 'node:fs';

import { resolveEphemeralProjectPaths, type RuntimeExclusiveLease } from '@opensip-cli/core';

import { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';
import {
  inspectRuntimePromotionFilesystem,
  readRuntimePromotionMarkerSha256,
  RuntimePromotionFilesystemLeaseMismatchError,
  runtimePromotionPathSnapshot,
  sameRuntimePromotionPathSnapshot,
  type RuntimePromotionFilesystemInspection,
  type RuntimePromotionSourceRevalidation,
} from './runtime-promotion-preflight-fs.js';
import {
  DEFAULT_RUNTIME_PROMOTION_RAW_MANIFEST_DEPENDENCIES,
  runtimePromotionRawIdentityMatchesVerified,
  runtimePromotionRawManifestIdentity,
  runtimePromotionRawManifestIdentityEqual,
  type RuntimePromotionPreliminaryManifestProof,
  type RuntimePromotionRawManifestIdentity,
} from './runtime-promotion-preflight-manifest.js';

import type { RuntimeManifestIdentity } from './runtime-promotion-journal-schema.js';
import type {
  RuntimePromotionPreflightRevalidationToken,
  RuntimePromotionPreflightSelected,
  RuntimePromotionRevalidationDependencies,
  RuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight-types.js';

const CHANGED_AFTER_PREFLIGHT = 'changed-after-preflight' as const;

function dependencies(
  overrides: Partial<RuntimePromotionRevalidationDependencies>,
): RuntimePromotionRevalidationDependencies {
  return {
    ...DEFAULT_RUNTIME_PROMOTION_RAW_MANIFEST_DEPENDENCIES,
    ...overrides,
  };
}

function assertLease(lease: RuntimeExclusiveLease, coordinationKey: string): void {
  if (
    lease.kind !== 'runtime-exclusive' ||
    lease.posture !== 'normal' ||
    lease.coordinationKey !== coordinationKey
  ) {
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
}

export function buildRuntimePromotionPreflightToken(
  inspection: RuntimePromotionFilesystemInspection,
  proof: RuntimePromotionPreliminaryManifestProof | undefined,
): RuntimePromotionPreflightRevalidationToken {
  return {
    version: 1,
    projectRoot: inspection.projectRoot,
    coordinationKey: inspection.ephemeral.coordinationKey,
    cacheKey: inspection.ephemeral.cacheKey,
    identityStrength: inspection.ephemeral.identityStrength,
    canonicalRootDigest: inspection.ephemeral.canonicalRootDigest,
    ...(inspection.ephemeral.generationDigest === undefined
      ? {}
      : { generationDigest: inspection.ephemeral.generationDigest }),
    projectRootSnapshot: inspection.projectRootSnapshot,
    activeCandidateDir: inspection.activeCandidateDir,
    activeCandidate: inspection.activeCandidate,
    ...(inspection.legacyCandidateDir === undefined || inspection.legacyCandidate === undefined
      ? {}
      : {
          legacyCandidateDir: inspection.legacyCandidateDir,
          legacyCandidate: inspection.legacyCandidate,
        }),
    destinationParentDir: inspection.destinationParentDir,
    destinationRuntimeDir: inspection.destinationRuntimeDir,
    destinationParent: inspection.destinationParent,
    destinationRuntime: inspection.destinationRuntime,
    ...(inspection.sourceRevalidation === undefined
      ? {}
      : { source: inspection.sourceRevalidation }),
    ...(proof === undefined ? {} : { preliminary: proof }),
  };
}

function sameResolvedIdentity(token: RuntimePromotionPreflightRevalidationToken): boolean {
  let current;
  try {
    current = resolveEphemeralProjectPaths(realpathSync(token.projectRoot));
  } catch {
    return false;
  }
  return (
    current.coordinationKey === token.coordinationKey &&
    current.cacheKey === token.cacheKey &&
    current.identityStrength === token.identityStrength &&
    current.canonicalRootDigest === token.canonicalRootDigest &&
    current.generationDigest === token.generationDigest
  );
}

function sourceUnchanged(source: RuntimePromotionSourceRevalidation): boolean {
  return (
    sameRuntimePromotionPathSnapshot(
      source.runtime,
      runtimePromotionPathSnapshot(source.runtimeDir),
    ) && readRuntimePromotionMarkerSha256(source) === source.markerSha256
  );
}

function preliminaryUnchanged(
  token: RuntimePromotionPreflightRevalidationToken,
  resolved: RuntimePromotionRevalidationDependencies,
): boolean {
  if (token.preliminary === undefined || token.source === undefined) return true;
  try {
    return (
      runtimePromotionRawManifestIdentityEqual(
        token.preliminary.source,
        runtimePromotionRawManifestIdentity(
          resolved.inspectRawTree(token.source.runtimeDir, 'cache-source'),
        ),
      ) &&
      runtimePromotionRawManifestIdentityEqual(
        token.preliminary.destination,
        runtimePromotionRawManifestIdentity(
          resolved.inspectRawTree(token.destinationRuntimeDir, 'project-runtime'),
        ),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Revalidate the complete preflight snapshot immediately before journal
 * creation. Do not reuse this token after SQLite checkpointing.
 */
export function assertRuntimePromotionPreflightUnchanged(
  input: {
    readonly lease: RuntimeExclusiveLease;
    readonly token: RuntimePromotionPreflightRevalidationToken;
  },
  dependencyOverrides: Partial<RuntimePromotionRevalidationDependencies> = {},
): void {
  const resolved = dependencies(dependencyOverrides);
  const { token } = input;
  assertLease(input.lease, token.coordinationKey);
  const unchanged =
    sameResolvedIdentity(token) &&
    sameRuntimePromotionPathSnapshot(
      token.projectRootSnapshot,
      runtimePromotionPathSnapshot(token.projectRoot),
    ) &&
    sameRuntimePromotionPathSnapshot(
      token.activeCandidate,
      runtimePromotionPathSnapshot(token.activeCandidateDir),
    ) &&
    (token.legacyCandidateDir === undefined || token.legacyCandidate === undefined
      ? token.legacyCandidateDir === undefined && token.legacyCandidate === undefined
      : sameRuntimePromotionPathSnapshot(
          token.legacyCandidate,
          runtimePromotionPathSnapshot(token.legacyCandidateDir),
        )) &&
    sameRuntimePromotionPathSnapshot(
      token.destinationParent,
      runtimePromotionPathSnapshot(token.destinationParentDir),
    ) &&
    sameRuntimePromotionPathSnapshot(
      token.destinationRuntime,
      runtimePromotionPathSnapshot(token.destinationRuntimeDir),
    ) &&
    (token.source === undefined || sourceUnchanged(token.source)) &&
    preliminaryUnchanged(token, resolved);
  if (!unchanged) throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
}

function sameSourceAuthority(
  selected: RuntimePromotionPreflightSelected,
  inspection: RuntimePromotionFilesystemInspection,
): boolean {
  return (
    selected.source.classification === inspection.source.classification &&
    selected.source.cacheKey === inspection.source.cacheKey &&
    selected.source.generationDigest === inspection.source.generationDigest &&
    selected.source.markerSha256 === inspection.source.markerSha256 &&
    selected.sourceRuntimeDir === inspection.sourceRevalidation?.runtimeDir
  );
}

/**
 * Refresh rename authority after journal-first checkpoint and authoritative
 * source-manifest verification.
 */
export function refreshRuntimePromotionSourceRetirementProof(
  input: {
    readonly lease: RuntimeExclusiveLease;
    readonly preflight: RuntimePromotionPreflightSelected;
    readonly verifiedSource: RuntimeManifestIdentity;
  },
  dependencyOverrides: Partial<RuntimePromotionRevalidationDependencies> = {},
): RuntimePromotionSourceRetirementProof {
  if (input.preflight.sourceRuntimeDir === undefined) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const resolved = dependencies(dependencyOverrides);
  let filesystem;
  try {
    filesystem = inspectRuntimePromotionFilesystem(
      input.preflight.revalidation.projectRoot,
      input.lease,
      resolved,
    );
  } catch (error) {
    if (error instanceof RuntimePromotionFilesystemLeaseMismatchError) {
      throw new RuntimePromotionPreflightError('lease-mismatch');
    }
    throw error;
  }
  if (
    filesystem.status !== 'ready' ||
    filesystem.inspection.sourceRevalidation === undefined ||
    !sameSourceAuthority(input.preflight, filesystem.inspection)
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  let manifest: RuntimePromotionRawManifestIdentity;
  try {
    manifest = runtimePromotionRawManifestIdentity(
      resolved.inspectRawTree(input.preflight.sourceRuntimeDir, 'cache-source'),
    );
  } catch {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  if (!runtimePromotionRawIdentityMatchesVerified(manifest, input.verifiedSource)) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const inspected = filesystem.inspection;
  const source = inspected.sourceRevalidation;
  if (source === undefined) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  return {
    version: 1,
    projectRoot: inspected.projectRoot,
    coordinationKey: inspected.ephemeral.coordinationKey,
    cacheKey: inspected.ephemeral.cacheKey,
    identityStrength: inspected.ephemeral.identityStrength,
    canonicalRootDigest: inspected.ephemeral.canonicalRootDigest,
    ...(inspected.ephemeral.generationDigest === undefined
      ? {}
      : { generationDigest: inspected.ephemeral.generationDigest }),
    activeCandidateDir: inspected.activeCandidateDir,
    activeCandidate: inspected.activeCandidate,
    ...(inspected.legacyCandidateDir === undefined || inspected.legacyCandidate === undefined
      ? {}
      : {
          legacyCandidateDir: inspected.legacyCandidateDir,
          legacyCandidate: inspected.legacyCandidate,
        }),
    source,
    manifest,
  };
}

/** Re-prove the refreshed source identity immediately before tombstone rename. */
export function assertRuntimePromotionSourceRetirementUnchanged(
  input: {
    readonly lease: RuntimeExclusiveLease;
    readonly proof: RuntimePromotionSourceRetirementProof;
  },
  dependencyOverrides: Partial<RuntimePromotionRevalidationDependencies> = {},
): void {
  const resolved = dependencies(dependencyOverrides);
  const { proof } = input;
  assertLease(input.lease, proof.coordinationKey);
  let currentIdentity;
  try {
    currentIdentity = resolveEphemeralProjectPaths(realpathSync(proof.projectRoot));
  } catch {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
  const candidatesUnchanged =
    sameRuntimePromotionPathSnapshot(
      proof.activeCandidate,
      runtimePromotionPathSnapshot(proof.activeCandidateDir),
    ) &&
    (proof.legacyCandidateDir === undefined || proof.legacyCandidate === undefined
      ? proof.legacyCandidateDir === undefined && proof.legacyCandidate === undefined
      : sameRuntimePromotionPathSnapshot(
          proof.legacyCandidate,
          runtimePromotionPathSnapshot(proof.legacyCandidateDir),
        ));
  let manifestUnchanged = false;
  try {
    manifestUnchanged = runtimePromotionRawManifestIdentityEqual(
      proof.manifest,
      runtimePromotionRawManifestIdentity(
        resolved.inspectRawTree(proof.source.runtimeDir, 'cache-source'),
      ),
    );
  } catch {
    manifestUnchanged = false;
  }
  if (
    currentIdentity.coordinationKey !== proof.coordinationKey ||
    currentIdentity.cacheKey !== proof.cacheKey ||
    currentIdentity.identityStrength !== proof.identityStrength ||
    currentIdentity.canonicalRootDigest !== proof.canonicalRootDigest ||
    currentIdentity.generationDigest !== proof.generationDigest ||
    !candidatesUnchanged ||
    !sourceUnchanged(proof.source) ||
    !manifestUnchanged
  ) {
    throw new RuntimePromotionPreflightError(CHANGED_AFTER_PREFLIGHT);
  }
}

export type {
  RuntimePromotionPreflightRevalidationToken,
  RuntimePromotionRevalidationDependencies,
  RuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight-types.js';
