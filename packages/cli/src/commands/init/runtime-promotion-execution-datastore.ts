import { RuntimePromotionDatastoreError } from './runtime-promotion-preflight.js';
import { assertFreshRuntimePromotionProjectRoot } from './runtime-promotion-root-authority.js';

import type { RuntimePromotionDatastoreCandidate } from './runtime-promotion-preflight.js';
import type { RuntimePromotionOperation } from './runtime-promotion-types.js';

/** @throws {Error} When runtime datastore authority cannot be checkpointed. */
export async function checkpointRuntimeDatastores(
  operation: RuntimePromotionOperation,
): Promise<RuntimePromotionOperation> {
  assertFreshRuntimePromotionProjectRoot(operation);
  const candidates: RuntimePromotionDatastoreCandidate[] = [];
  if (operation.preflight.source.classification !== 'none') {
    if (operation.preflight.sourceRuntimeDir === undefined) {
      throw new Error('Selected cache evidence has no source runtime path');
    }
    candidates.push({
      kind: 'source',
      runtimeDir: operation.preflight.sourceRuntimeDir,
    });
  }
  if (operation.preflight.destinationRuntimePreexisting) {
    candidates.push({
      kind: 'destination',
      runtimeDir: operation.preflight.destinationRuntimeDir,
    });
  }
  try {
    await operation.dependencies.checkpointDatastores({
      candidates,
      lockContext: operation.input.datastoreLockContext,
      projectRootAuthority: operation.projectRootAuthority,
      lease: operation.lease,
      controller: operation.controller,
      receipt: operation.receipt,
    });
  } catch (error) {
    if (error instanceof RuntimePromotionDatastoreError && !error.releaseSafe) {
      operation.leaseDisposition.releaseSafe = false;
    }
    throw error;
  }
  assertFreshRuntimePromotionProjectRoot(operation);
  operation.dependencies.checkpoint?.('after-datastore-checkpoint');
  return operation;
}
