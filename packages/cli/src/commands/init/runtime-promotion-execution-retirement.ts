import { runtimeManifestIdentityEqual } from './runtime-manifest.js';
import { authorityUnverified } from './runtime-promotion-authority-error.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';
import { runtimePromotionMutationOutcome } from './runtime-promotion-transitions-common.js';

import type { RuntimePromotionSourceRetirementProof } from './runtime-promotion-preflight.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

const SOURCE_ROUTES = new Set(['promote-cache', 'keep-project', 'deduplicate-cache']);

export function runtimePromotionUsesSelectedSource(
  route: RuntimePromotionOperation['preflight']['route'],
): boolean {
  return SOURCE_ROUTES.has(route);
}

/** @throws {Error} When the selected cache source cannot be retired with fresh authority. */
export async function retireSelectedSource(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  if (!runtimePromotionUsesSelectedSource(operation.preflight.route)) {
    return operation;
  }
  if (operation.sourceManifest === null || operation.preflight.sourceRuntimeDir === undefined) {
    operation.sourcePreserved = false;
    authorityUnverified(
      'Source retirement requires verified cache authority',
      'retirement-cache-authority-unverified',
    );
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  const destinationAuthority = operation.dependencies.inspectManifest(
    operation.preflight.destinationRuntimeDir,
    'project-runtime',
  );
  assertFreshRuntimePromotionProjectRoot(operation);
  const expectedDestination =
    operation.preflight.route === 'promote-cache'
      ? operation.sourceManifest.identity
      : operation.destinationManifest?.identity;
  if (
    expectedDestination === undefined ||
    !runtimeManifestIdentityEqual(destinationAuthority.identity, expectedDestination)
  ) {
    authorityUnverified(
      'Project runtime authority changed before cache retirement',
      'retirement-project-authority-changed',
    );
  }
  let proof: RuntimePromotionSourceRetirementProof;
  try {
    proof = operation.dependencies.refreshSourceRetirementProof({
      lease: operation.lease,
      preflight: operation.preflight,
      verifiedSource: operation.sourceManifest.identity,
    });
  } catch (error) {
    operation.sourcePreserved = false;
    throw error;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordSourceRetireIntent(operation.receipt);
  try {
    operation.dependencies.assertSourceRetirementUnchanged({
      lease: operation.lease,
      proof,
    });
  } catch (error) {
    operation.sourcePreserved = false;
    throw error;
  }
  const authority = await operation.dependencies.authorizeFilesystem({
    action: 'source-retire',
    projectRoot: operation.input.projectRoot,
    projectRootAuthority: operation.projectRootAuthority,
    sourceRuntime: operation.preflight.sourceRuntimeDir,
    controller: operation.controller,
    lease: operation.lease,
    receipt: operation.receipt,
  });
  operation.sourcePreserved = false;
  const result = await operation.dependencies.retireSource(
    authority,
    operation.sourceManifest.identity,
  );
  if (!runtimeManifestIdentityEqual(result.manifest.identity, operation.sourceManifest.identity)) {
    authorityUnverified(
      'Retired source tombstone authority does not match the selected source',
      'retirement-tombstone-mismatch',
    );
  }
  operation.sourcePreserved = true;
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.receipt = await operation.writer.recordSourceRetired(
    operation.receipt,
    runtimePromotionMutationOutcome(result.status),
  );
  operation.dependencies.checkpoint?.('after-source-retired');
  return operation;
}
