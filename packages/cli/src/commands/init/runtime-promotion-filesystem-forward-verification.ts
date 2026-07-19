import { runtimeManifestIdentityEqual } from './runtime-manifest.js';
import { runtimePromotionFilesystemFailure } from './runtime-promotion-filesystem-io.js';

import type { RuntimeManifestIdentity, RuntimeStageOwnershipIdentity } from './runtime-manifest.js';

export const PROJECT_RUNTIME_POSTURE = 'project-runtime';

/** Construct the exact stage ownership identity recorded by a promotion journal. */
export function stageOwnership(
  operationId: string,
  stageBasename: string,
  ownershipId: string,
): RuntimeStageOwnershipIdentity {
  return { operationId, stageBasename, ownershipId };
}

/**
 * Require an observed manifest identity to match the journal's expected identity.
 *
 * @throws When the identity is absent or differs from the journal.
 */
export function assertExpectedIdentity(
  actual: RuntimeManifestIdentity | null,
  expected: RuntimeManifestIdentity,
  description: string,
): void {
  if (actual === null || !runtimeManifestIdentityEqual(actual, expected)) {
    runtimePromotionFilesystemFailure(`${description} does not match the journal`);
  }
}
