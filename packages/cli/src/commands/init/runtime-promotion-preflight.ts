import { resolveUserPaths } from '@opensip-cli/core';

import { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';
import {
  bindRuntimePromotionCacheChild,
  inspectRuntimePromotionFilesystem,
  runtimePromotionPathSnapshot,
  RuntimePromotionFilesystemLeaseMismatchError,
  sameRuntimePromotionPathSnapshot,
  type RuntimePromotionFilesystemInspection,
} from './runtime-promotion-preflight-fs.js';
import {
  DEFAULT_RUNTIME_PROMOTION_RAW_MANIFEST_DEPENDENCIES,
  runtimePromotionRawManifestIdentity,
  runtimePromotionRawManifestsEqual,
  type RuntimePromotionPreliminaryManifestProof,
} from './runtime-promotion-preflight-manifest.js';
import {
  selectRuntimePromotionAuthority,
  type RuntimePromotionAuthorityPolicySelection,
  type RuntimePromotionPreflightConflictReason,
  type RuntimePromotionPreliminaryEquality,
} from './runtime-promotion-preflight-policy.js';
import {
  assertRuntimePromotionPreflightUnchanged,
  buildRuntimePromotionPreflightToken,
} from './runtime-promotion-preflight-revalidation.js';

import type {
  RuntimePromotionConflictPolicy,
  RuntimePromotionRootIdentity,
} from './runtime-promotion-journal-schema.js';
import type {
  RuntimePromotionPreflightConflict,
  RuntimePromotionPreflightDependencies,
  RuntimePromotionPreflightInput,
  RuntimePromotionPreflightResult,
} from './runtime-promotion-preflight-types.js';

const DEFAULT_DEPENDENCIES: RuntimePromotionPreflightDependencies = Object.freeze({
  ...DEFAULT_RUNTIME_PROMOTION_RAW_MANIFEST_DEPENDENCIES,
});

function conflictFromFilesystem(
  reason: RuntimePromotionPreflightConflictReason,
  sourcePreserved: boolean,
  requested: RuntimePromotionConflictPolicy,
): RuntimePromotionPreflightConflict {
  return {
    status: 'conflict',
    reason,
    effectiveConflict: requested,
    sourcePreserved,
    allowedPolicies: [],
  };
}

function conflictFromPolicy(
  selection: Extract<RuntimePromotionAuthorityPolicySelection, { readonly status: 'conflict' }>,
): RuntimePromotionPreflightConflict {
  return selection;
}

/** @throws {RuntimePromotionPreflightError} When a selected source is not canonically located. */
function canonicalSourceRuntimeDir(
  inspection: RuntimePromotionFilesystemInspection,
): string | undefined {
  const source = inspection.sourceRevalidation;
  if (source === undefined) return undefined;
  const canonical = bindRuntimePromotionCacheChild(
    resolveUserPaths().ephemeralProjectsDir,
    source.cacheKey,
  );
  if (
    !sameRuntimePromotionPathSnapshot(
      source.runtime,
      runtimePromotionPathSnapshot(canonical.runtimeDir),
    )
  ) {
    throw new RuntimePromotionPreflightError('changed-after-preflight');
  }
  return canonical.runtimeDir;
}

/** @throws {RuntimePromotionPreflightError} When destination root identity is missing or unsafe. */
function destinationRootIdentity(
  inspection: RuntimePromotionFilesystemInspection,
): RuntimePromotionRootIdentity | null {
  if (inspection.destinationRuntime.presence !== 'directory') return null;
  const identity = inspection.destinationRuntime.identity;
  if (identity === undefined) {
    throw new RuntimePromotionPreflightError('changed-after-preflight');
  }
  return { device: identity.dev, inode: identity.ino };
}

function preliminaryEquality(input: {
  readonly inspection: RuntimePromotionFilesystemInspection;
  readonly requested: RuntimePromotionConflictPolicy;
  readonly dependencies: RuntimePromotionPreflightDependencies;
}): {
  readonly equality: RuntimePromotionPreliminaryEquality;
  readonly proof?: RuntimePromotionPreliminaryManifestProof;
} {
  const { source, sourceRevalidation, destinationRuntime } = input.inspection;
  if (
    input.requested !== 'abort' ||
    source.classification !== 'generation-bound' ||
    sourceRevalidation === undefined ||
    destinationRuntime.presence !== 'directory'
  ) {
    return { equality: 'not-required' };
  }
  try {
    const sourceManifest = input.dependencies.inspectRawTree(
      sourceRevalidation.runtimeDir,
      'cache-source',
    );
    input.dependencies.checkpoint?.('after-source-manifest');
    const destinationManifest = input.dependencies.inspectRawTree(
      input.inspection.destinationRuntimeDir,
      'project-runtime',
    );
    input.dependencies.checkpoint?.('after-destination-manifest');
    return {
      equality: runtimePromotionRawManifestsEqual(sourceManifest, destinationManifest)
        ? 'verified-equal'
        : 'verified-different',
      proof: {
        source: runtimePromotionRawManifestIdentity(sourceManifest),
        destination: runtimePromotionRawManifestIdentity(destinationManifest),
      },
    };
  } catch {
    return { equality: 'unverified' };
  }
}

/**
 * Resolve fresh authority without creating a journal, opening SQLite, or
 * mutating cache/project state.
 */
/** @throws {RuntimePromotionPreflightError} When runtime-promotion authority cannot be established. */
export function preflightRuntimePromotionAuthority(
  input: RuntimePromotionPreflightInput,
  dependencyOverrides: Partial<RuntimePromotionPreflightDependencies> = {},
): RuntimePromotionPreflightResult {
  const requested = input.conflict ?? 'abort';
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  let filesystem;
  try {
    filesystem = inspectRuntimePromotionFilesystem(input.projectRoot, input.lease, dependencies);
  } catch (error) {
    if (!(error instanceof RuntimePromotionFilesystemLeaseMismatchError)) throw error;
    throw new RuntimePromotionPreflightError('lease-mismatch');
  }
  if (filesystem.status === 'conflict') {
    return conflictFromFilesystem(filesystem.reason, filesystem.sourcePreserved, requested);
  }
  dependencies.checkpoint?.('after-filesystem-inspection');
  const preliminary = preliminaryEquality({
    inspection: filesystem.inspection,
    requested,
    dependencies,
  });
  const policy = selectRuntimePromotionAuthority({
    sourceClassification: filesystem.inspection.source.classification,
    destinationRuntimePreexisting:
      filesystem.inspection.destinationRuntime.presence === 'directory',
    requestedConflict: requested,
    preliminaryEquality: preliminary.equality,
  });
  if (policy.status === 'conflict') return conflictFromPolicy(policy);

  const token = buildRuntimePromotionPreflightToken(filesystem.inspection, preliminary.proof);
  const sourceRuntimeDir = canonicalSourceRuntimeDir(filesystem.inspection);
  dependencies.checkpoint?.('before-return');
  assertRuntimePromotionPreflightUnchanged({ lease: input.lease, token }, dependencies);
  return {
    status: 'selected',
    route: policy.route,
    effectiveConflict: policy.effectiveConflict,
    source: filesystem.inspection.source,
    destinationParentPreexisting: filesystem.inspection.destinationParent.presence === 'directory',
    destinationRuntimePreexisting:
      filesystem.inspection.destinationRuntime.presence === 'directory',
    destinationRootIdentity: destinationRootIdentity(filesystem.inspection),
    ...(sourceRuntimeDir === undefined ? {} : { sourceRuntimeDir }),
    destinationParentDir: filesystem.inspection.destinationParentDir,
    destinationRuntimeDir: filesystem.inspection.destinationRuntimeDir,
    preliminaryEquality: preliminary.equality,
    revalidation: token,
  };
}

export {
  checkpointRuntimePromotionDatastores,
  RuntimePromotionDatastoreError,
} from './runtime-promotion-preflight-datastore.js';
export type {
  RuntimePromotionDatastoreCandidate,
  RuntimePromotionDatastoreCheckpointInput,
  RuntimePromotionDatastoreDependencies,
  RuntimePromotionDatastoreFailureReason,
  RuntimePromotionDatastoreIdentity,
  RuntimePromotionDatastoreKind,
} from './runtime-promotion-preflight-datastore.js';
export { RuntimePromotionPreflightError } from './runtime-promotion-preflight-error.js';
export type { RuntimePromotionPreflightFailureReason } from './runtime-promotion-preflight-error.js';
export { selectRuntimePromotionAuthority } from './runtime-promotion-preflight-policy.js';
export type {
  RuntimePromotionAuthorityPolicyInput,
  RuntimePromotionAuthorityPolicySelection,
  RuntimePromotionPreflightConflictReason,
  RuntimePromotionPreliminaryEquality,
} from './runtime-promotion-preflight-policy.js';
export {
  assertRuntimePromotionPreflightUnchanged,
  assertRuntimePromotionSourceRetirementUnchanged,
  refreshRuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight-revalidation.js';
export {
  assertRuntimePromotionRecoverySourceAuthority,
  assertRuntimePromotionRecoverySourceLocation,
} from './runtime-promotion-preflight-fs.js';
export type { RuntimePromotionRecoverySourceAuthorityInput } from './runtime-promotion-preflight-fs.js';
export type {
  RuntimePromotionPreflightCheckpoint,
  RuntimePromotionPreflightConflict,
  RuntimePromotionPreflightDependencies,
  RuntimePromotionPreflightInput,
  RuntimePromotionPreflightResult,
  RuntimePromotionPreflightSelected,
  RuntimePromotionPreflightRevalidationToken,
  RuntimePromotionRevalidationDependencies,
  RuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight-types.js';
export {
  assertRuntimePromotionProjectRootAuthority,
  bindRuntimePromotionFreshProjectRootAuthority,
  captureRuntimePromotionProjectRootAuthority,
} from './runtime-promotion-root-authority.js';
export type { RuntimePromotionProjectRootAuthority } from './runtime-promotion-root-authority.js';
