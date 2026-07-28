import { basename } from 'node:path';

import { acquireRuntimeExclusiveLease } from '@opensip-cli/core';

import {
  bindAuthoredStateReceipt,
  cleanupAuthoredState,
  commitAuthoredState,
  loadClosedAuthoredState,
  prepareAuthoredState,
  rollbackAuthoredState,
  verifyAuthoredState,
} from './authored-state-transaction.js';
import { createInitAuthoredPlan } from './init-authored-plan.js';
import {
  copyRuntimeToStage,
  inspectVerifiedRuntimeManifest,
  isRuntimeManifestReleaseUnsafe,
} from './runtime-manifest.js';
import { cleanupFreshClosedRuntimePromotion } from './runtime-promotion-cleanup.js';
import { assertRuntimePromotionDestinationRootAuthority } from './runtime-promotion-destination-authority.js';
import { executeRuntimePromotionForward } from './runtime-promotion-execution.js';
import {
  authorizeRuntimePromotionFilesystem,
  backupRuntimePromotionDestination,
  cleanupRuntimePromotionOwnedSlot,
  createRuntimePromotionDestinationParent,
  installRuntimePromotionStage,
  reconcileRuntimePromotionStage,
  retireRuntimePromotionSource,
  rollbackRuntimePromotion,
} from './runtime-promotion-filesystem.js';
import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
} from './runtime-promotion-journal-schema.js';
import { createRuntimePromotionJournalController } from './runtime-promotion-journal.js';
import {
  assertRuntimePromotionPreflightUnchanged,
  assertRuntimePromotionSourceRetirementUnchanged,
  checkpointRuntimePromotionDatastores,
  preflightRuntimePromotionAuthority,
  refreshRuntimePromotionSourceRetirementProof,
} from './runtime-promotion-preflight.js';
import {
  busyResult,
  committedResult,
  conflictResult,
  recoveryRequiredResult,
} from './runtime-promotion-result.js';
import { rollbackFreshRuntimePromotion } from './runtime-promotion-rollback.js';
import {
  assertRuntimePromotionProjectRootAuthority,
  bindRuntimePromotionFreshProjectRootAuthority,
  reportInitFailure,
} from './runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from './runtime-promotion-transitions.js';

import type {
  FreshRuntimePromotionInput,
  RuntimePromotionDependencies,
  RuntimePromotionOperation,
} from './runtime-promotion-types.js';
import type { RuntimeAdoptionResult } from '@opensip-cli/contracts';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

export type {
  FreshRuntimePromotionInput,
  RuntimePromotionCheckpoint,
  RuntimePromotionDependencies,
} from './runtime-promotion-types.js';

class RuntimePromotionJournalCreationError extends Error {
  constructor(readonly cause: unknown) {
    super('Fresh runtime promotion journal creation did not complete');
    this.name = 'RuntimePromotionJournalCreationError';
  }
}

function defaultDependencies(
  overrides: Partial<RuntimePromotionDependencies>,
): RuntimePromotionDependencies {
  const now = overrides.now ?? Date.now;
  const defaults: RuntimePromotionDependencies = {
    now,
    acquireLease: acquireRuntimeExclusiveLease,
    preflight: preflightRuntimePromotionAuthority,
    assertPreflightUnchanged: assertRuntimePromotionPreflightUnchanged,
    bindProjectRootAuthority: bindRuntimePromotionFreshProjectRootAuthority,
    assertProjectRootAuthority: assertRuntimePromotionProjectRootAuthority,
    assertDestinationRootAuthority: ({ runtimeDir, journal }) =>
      assertRuntimePromotionDestinationRootAuthority(runtimeDir, journal),
    checkpointDatastores: checkpointRuntimePromotionDatastores,
    createPlan: createInitAuthoredPlan,
    createController: (lease) => createRuntimePromotionJournalController(lease, { now }),
    createWriter: (controller) => createRuntimePromotionTransitionWriter(controller, { now }),
    inspectManifest: inspectVerifiedRuntimeManifest,
    copyStage: copyRuntimeToStage,
    prepareAuthored: prepareAuthoredState,
    bindAuthoredReceipt: bindAuthoredStateReceipt,
    loadClosedAuthored: loadClosedAuthoredState,
    commitAuthored: commitAuthoredState,
    rollbackAuthored: rollbackAuthoredState,
    verifyAuthored: verifyAuthoredState,
    cleanupAuthored: cleanupAuthoredState,
    authorizeFilesystem: authorizeRuntimePromotionFilesystem,
    createDestinationParent: createRuntimePromotionDestinationParent,
    reconcileStage: reconcileRuntimePromotionStage,
    backupDestination: backupRuntimePromotionDestination,
    installStage: installRuntimePromotionStage,
    refreshSourceRetirementProof: refreshRuntimePromotionSourceRetirementProof,
    assertSourceRetirementUnchanged: assertRuntimePromotionSourceRetirementUnchanged,
    retireSource: retireRuntimePromotionSource,
    rollbackRuntime: rollbackRuntimePromotion,
    cleanupOwnedSlot: cleanupRuntimePromotionOwnedSlot,
  };
  return { ...defaults, ...overrides, now };
}

function isLeaseBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (
    error.code === 'CORE.RUNTIME_LEASE.EXCLUSIVE' || error.code === 'CORE.RUNTIME_COORDINATION.BUSY'
  );
}

async function acquireNormalLease(
  input: FreshRuntimePromotionInput,
  dependencies: RuntimePromotionDependencies,
): Promise<RuntimeExclusiveLease> {
  return dependencies.acquireLease({
    projectDir: input.projectRoot,
    posture: 'normal',
    command: 'opensip init',
    cwdBasename: basename(input.projectRoot),
  });
}

/** @throws {Error} When planning, authority binding, or durable operation setup fails. */
async function createOperation(input: {
  readonly request: FreshRuntimePromotionInput;
  readonly dependencies: RuntimePromotionDependencies;
  readonly startedAt: number;
  readonly lease: RuntimeExclusiveLease;
  readonly leaseDisposition: { releaseSafe: boolean };
  readonly preflight: Extract<
    ReturnType<RuntimePromotionDependencies['preflight']>,
    { readonly status: 'selected' }
  >;
}): Promise<RuntimePromotionOperation> {
  const plan = input.dependencies.createPlan({
    projectRoot: input.request.projectRoot,
    languages: input.request.languages,
    mode: input.request.authoredMode,
    toolScaffolds: input.request.toolScaffolds,
  });
  input.dependencies.checkpoint?.('after-authored-plan');
  input.dependencies.assertPreflightUnchanged({
    lease: input.lease,
    token: input.preflight.revalidation,
  });
  const projectRootAuthority = input.dependencies.bindProjectRootAuthority({
    lease: input.lease,
    token: input.preflight.revalidation,
  });
  const controller = input.dependencies.createController(input.lease);
  const writer = input.dependencies.createWriter(controller);
  const allocation = controller.allocate((identity) =>
    createInitialRuntimePromotionJournal({
      coordinationKey: input.lease.coordinationKey,
      operationId: identity.operationId,
      recoveryOwnerToken: identity.recoveryOwnerToken,
      route: input.preflight.route,
      destinationParentPreexisting: input.preflight.destinationParentPreexisting,
      destinationRuntimePreexisting: input.preflight.destinationRuntimePreexisting,
      destinationRootIdentity: input.preflight.destinationRootIdentity,
      source: input.preflight.source,
      inputs: {
        conflict: input.preflight.effectiveConflict,
        authoredMode: plan.inputs.mode,
        languages: plan.inputs.languages,
        languageExplicit: input.request.languageExplicit,
      },
      plan: {
        authoredDigest: plan.digest,
        replayDigest: plan.replayManifestDigest,
        mutationCount: plan.mutations.length,
      },
      owned: createRuntimePromotionOwnedSlots(identity.operationId),
      createdAt: identity.createdAt,
    }),
  );
  let receipt;
  try {
    receipt = await controller.create(allocation);
  } catch (error) {
    throw new RuntimePromotionJournalCreationError(error);
  }
  return {
    input: input.request,
    dependencies: input.dependencies,
    startedAt: input.startedAt,
    lease: input.lease,
    leaseDisposition: input.leaseDisposition,
    projectRootAuthority,
    preflight: input.preflight,
    plan,
    controller,
    writer,
    receipt,
    sourcePreserved: input.preflight.source.classification !== 'none',
    sourceManifest: null,
    destinationManifest: null,
    transaction: null,
    authoredSummary: null,
  };
}

async function runWithLease(
  input: FreshRuntimePromotionInput,
  dependencies: RuntimePromotionDependencies,
  startedAt: number,
  lease: RuntimeExclusiveLease,
  leaseDisposition: { releaseSafe: boolean },
): Promise<RuntimeAdoptionResult> {
  dependencies.checkpoint?.('after-lease-acquired');
  const preflight = dependencies.preflight({
    projectRoot: input.projectRoot,
    lease,
    ...(input.conflict === undefined ? {} : { conflict: input.conflict }),
  });
  dependencies.checkpoint?.('after-preflight');
  if (preflight.status === 'conflict') {
    return conflictResult(preflight, startedAt, dependencies.now);
  }
  const canonicalInput: FreshRuntimePromotionInput = {
    ...input,
    projectRoot: preflight.revalidation.projectRoot,
  };
  let operation: RuntimePromotionOperation;
  try {
    operation = await createOperation({
      request: canonicalInput,
      dependencies,
      startedAt,
      lease,
      leaseDisposition,
      preflight,
    });
  } catch (error) {
    if (!(error instanceof RuntimePromotionJournalCreationError)) throw error;
    return recoveryRequiredResult({
      preflight,
      authored: null,
      sourcePreserved: preflight.source.classification !== 'none',
      startedAt,
      now: dependencies.now,
    });
  }
  try {
    dependencies.checkpoint?.('after-journal-created');
    try {
      dependencies.assertPreflightUnchanged({
        lease,
        token: preflight.revalidation,
      });
      dependencies.assertProjectRootAuthority({
        lease,
        authority: operation.projectRootAuthority,
      });
    } catch (error) {
      if (preflight.source.classification !== 'none') {
        operation.sourcePreserved = false;
      }
      throw error;
    }
    const closed = await executeRuntimePromotionForward(operation);
    const cleanup = await cleanupFreshClosedRuntimePromotion(operation, closed);
    return committedResult({
      preflight,
      authored: operation.authoredSummary,
      cleanupPending: cleanup.cleanupPending,
      startedAt,
      now: dependencies.now,
    });
  } catch (error) {
    if (isRuntimeManifestReleaseUnsafe(error)) {
      operation.leaseDisposition.releaseSafe = false;
    }
    // Report before rolling back. This arm read ONE flag off the error and then dropped it:
    // never logged, never attached to the result. So a fresh promotion that failed rolled back
    // silently and the operator saw a recovery outcome with no cause — the failure that
    // triggered it was unrecoverable from outside the process.
    reportInitFailure('fresh-promotion-failed', error);
    const rollback = await rollbackFreshRuntimePromotion(operation);
    return rollback.result;
  }
}

/**
 * Adopt cache runtime authority and apply Init-authored state under one normal
 * exclusive lease. Customer output stays bounded and path-free; durable detail
 * remains in the journal until identity-bound cleanup succeeds.
 */
export async function runFreshRuntimePromotion(
  input: FreshRuntimePromotionInput,
  dependencyOverrides: Partial<RuntimePromotionDependencies> = {},
): Promise<RuntimeAdoptionResult> {
  const dependencies = defaultDependencies(dependencyOverrides);
  const startedAt = dependencies.now();
  let lease: RuntimeExclusiveLease;
  try {
    lease = await acquireNormalLease(input, dependencies);
  } catch (error) {
    if (isLeaseBusy(error)) return busyResult(startedAt, dependencies.now);
    throw error;
  }
  const leaseDisposition = { releaseSafe: true };
  try {
    return await runWithLease(input, dependencies, startedAt, lease, leaseDisposition);
  } finally {
    if (leaseDisposition.releaseSafe) lease.release();
  }
}
