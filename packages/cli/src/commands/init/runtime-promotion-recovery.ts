import { realpathSync } from 'node:fs';

import {
  acquireRuntimeExclusiveLease,
  inspectRuntimePromotionRecoveryHeader,
  resolveUserPaths,
} from '@opensip-cli/core';

import {
  abortPendingAuthoredPreparation,
  bindAuthoredStateReceipt,
  cleanupAuthoredState,
  commitAuthoredState,
  loadAuthoredState,
  loadClosedAuthoredState,
  rollbackAuthoredState,
  verifyAuthoredState,
} from './authored-state-transaction.js';
import {
  copyRuntimeToStage,
  inspectVerifiedRuntimeManifest,
  isRuntimeManifestReleaseUnsafe,
} from './runtime-manifest.js';
import { assertRuntimePromotionDestinationRootAuthority } from './runtime-promotion-destination-authority.js';
import {
  authorizeRuntimePromotionFilesystem,
  backupRuntimePromotionDestination,
  classifyRuntimePromotionPath,
  cleanupRuntimePromotionOwnedSlot,
  createRuntimePromotionDestinationParent,
  installRuntimePromotionStage,
  reconcileRuntimePromotionStage,
  retireRuntimePromotionSource,
  rollbackRuntimePromotion,
} from './runtime-promotion-filesystem.js';
import {
  createRuntimePromotionJournalController,
  handoffRuntimePromotionRecoveryOwner,
} from './runtime-promotion-journal.js';
import {
  assertRuntimePromotionRecoverySourceAuthority,
  assertRuntimePromotionRecoverySourceLocation,
  checkpointRuntimePromotionDatastores,
  RuntimePromotionDatastoreError,
} from './runtime-promotion-preflight.js';
import { cleanupRecoveredClosedRuntimePromotion } from './runtime-promotion-recovery-closed.js';
import {
  asRecoveryClosed,
  deriveRecoverySourceRuntime,
  recoveryFailureReason,
  recoveryInputsCompatible,
} from './runtime-promotion-recovery-common.js';
import { recoverOpenRuntimePromotion } from './runtime-promotion-recovery-open-coordinator.js';
import {
  recoveredTerminalResult,
  recoveryInputConflictResult,
  recoveryRequiredFromJournal,
} from './runtime-promotion-recovery-result.js';
import {
  acquireRecoveryLeaseOrResult,
  inspectRecoveryStart,
  type RecoveryStart,
} from './runtime-promotion-recovery-start.js';
import {
  assertRuntimePromotionProjectRootAuthority,
  captureRuntimePromotionRecoveryProjectRootAuthority,
} from './runtime-promotion-root-authority.js';
import { createRuntimePromotionTransitionWriter } from './runtime-promotion-transitions.js';

import type { RuntimePromotionJournal } from './runtime-promotion-journal-schema.js';
import type {
  DurableClosedPromotionJournal,
  DurablePromotionJournal,
} from './runtime-promotion-journal.js';
import type {
  RecoverRuntimePromotionInput,
  RuntimePromotionRecoveryDependencies,
  RuntimePromotionRecoveryOperation,
} from './runtime-promotion-recovery-types.js';
import type { RuntimeAdoptionResult } from '@opensip-cli/contracts';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

export type {
  RecoverRuntimePromotionInput,
  RuntimePromotionRecoveryCheckpoint,
  RuntimePromotionRecoveryDependencies,
  RuntimePromotionRecoveryExplicitInputs,
} from './runtime-promotion-recovery-types.js';

function defaultDependencies(
  overrides: Partial<RuntimePromotionRecoveryDependencies>,
): RuntimePromotionRecoveryDependencies {
  const now = overrides.now ?? Date.now;
  const defaults: RuntimePromotionRecoveryDependencies = {
    now,
    canonicalizeProjectRoot: realpathSync,
    inspectHeader: inspectRuntimePromotionRecoveryHeader,
    acquireLease: acquireRuntimeExclusiveLease,
    ephemeralProjectsDir: () => resolveUserPaths().ephemeralProjectsDir,
    assertSourceAuthority: assertRuntimePromotionRecoverySourceAuthority,
    assertSourceLocation: assertRuntimePromotionRecoverySourceLocation,
    checkpointDatastores: checkpointRuntimePromotionDatastores,
    createController: (lease) => createRuntimePromotionJournalController(lease, { now }),
    createWriter: (controller) => createRuntimePromotionTransitionWriter(controller, { now }),
    captureProjectRootAuthority: captureRuntimePromotionRecoveryProjectRootAuthority,
    assertProjectRootAuthority: assertRuntimePromotionProjectRootAuthority,
    assertDestinationRootAuthority: ({ runtimeDir, journal }) =>
      assertRuntimePromotionDestinationRootAuthority(runtimeDir, journal),
    inspectManifest: inspectVerifiedRuntimeManifest,
    classifyPath: classifyRuntimePromotionPath,
    copyStage: copyRuntimeToStage,
    loadAuthored: loadAuthoredState,
    abortAuthoredPreparation: abortPendingAuthoredPreparation,
    bindAuthoredReceipt: bindAuthoredStateReceipt,
    commitAuthored: commitAuthoredState,
    rollbackAuthored: rollbackAuthoredState,
    verifyAuthored: verifyAuthoredState,
    loadClosedAuthored: loadClosedAuthoredState,
    cleanupAuthored: cleanupAuthoredState,
    authorizeFilesystem: authorizeRuntimePromotionFilesystem,
    createDestinationParent: createRuntimePromotionDestinationParent,
    reconcileStage: reconcileRuntimePromotionStage,
    backupDestination: backupRuntimePromotionDestination,
    installStage: installRuntimePromotionStage,
    retireSource: retireRuntimePromotionSource,
    rollbackRuntime: rollbackRuntimePromotion,
    cleanupOwnedSlot: cleanupRuntimePromotionOwnedSlot,
  };
  return { ...defaults, ...overrides, now };
}

/** @throws {Error} When the claimed durable journal is incompatible with recovery inputs. */
async function claimValidatedJournal(input: {
  readonly controller: ReturnType<RuntimePromotionRecoveryDependencies['createController']>;
  readonly operationId: string;
}): Promise<{
  readonly receipt: DurablePromotionJournal;
  readonly journal: RuntimePromotionJournal;
}> {
  const receipt = await input.controller.claim(input.operationId);
  const journal = await input.controller.verifyReceipt(receipt, {
    state: receipt.state,
  });
  if (journal.operationId !== input.operationId) {
    throw new Error('Recovered journal operation identity changed after claim');
  }
  return { receipt, journal };
}

function recoveryFailure(input: {
  readonly journal?: RuntimePromotionJournal;
  readonly operation?: RuntimePromotionRecoveryOperation;
  readonly startedAt: number;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly reasonCode?: Parameters<typeof recoveryRequiredFromJournal>[0]['reasonCode'];
}): RuntimeAdoptionResult {
  return recoveryRequiredFromJournal({
    ...(input.journal === undefined ? {} : { journal: input.journal }),
    ...(input.operation?.authoredSummary === null || input.operation?.authoredSummary === undefined
      ? {}
      : { authored: input.operation.authoredSummary }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    startedAt: input.startedAt,
    now: input.dependencies.now,
  });
}

async function executeRecoveryUnderLease(input: {
  readonly request: RecoverRuntimePromotionInput;
  readonly projectRoot: string;
  readonly operationId: string;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly startedAt: number;
  readonly lease: RuntimeExclusiveLease;
  readonly leaseDisposition: { releaseSafe: boolean };
  readonly state: {
    journal?: RuntimePromotionJournal;
    operation?: RuntimePromotionRecoveryOperation;
  };
}): Promise<RuntimeAdoptionResult> {
  const controller = input.dependencies.createController(input.lease);
  const claimed = await claimValidatedJournal({
    controller,
    operationId: input.operationId,
  });
  input.state.journal = claimed.journal;
  input.dependencies.onJournal?.(claimed.journal);
  input.dependencies.checkpoint?.('after-journal-claimed');
  if (!recoveryInputsCompatible(claimed.journal, input.request.explicit)) {
    return recoveryInputConflictResult(claimed.journal, input.startedAt, input.dependencies.now);
  }
  const receipt = await handoffRuntimePromotionRecoveryOwner(controller, claimed.receipt);
  input.dependencies.checkpoint?.('after-owner-handoff');
  const journal = await controller.verifyReceipt(receipt, {
    state: receipt.state,
  });
  input.state.journal = journal;
  const projectRootAuthority = input.dependencies.captureProjectRootAuthority({
    lease: input.lease,
    projectRoot: input.projectRoot,
    destinationParentPreexisting: journal.destinationParentPreexisting,
  });
  input.dependencies.checkpoint?.('after-root-authority-captured');
  const operation: RuntimePromotionRecoveryOperation = {
    input: {
      projectRoot: input.projectRoot,
      datastoreLockContext: input.request.datastoreLockContext,
    },
    dependencies: input.dependencies,
    startedAt: input.startedAt,
    lease: input.lease,
    controller,
    writer: input.dependencies.createWriter(controller),
    projectRootAuthority,
    ...(journal.source.cacheKey === null
      ? {}
      : {
          sourceRuntime: deriveRecoverySourceRuntime(
            journal,
            input.dependencies.ephemeralProjectsDir(),
          ),
        }),
    receipt,
    journal,
    transaction: null,
    authoredSummary: null,
    journalUnlinked: false,
  };
  input.state.operation = operation;
  let closedReceipt: DurableClosedPromotionJournal;
  if (operation.receipt.state === 'open') {
    closedReceipt = await recoverOpenRuntimePromotion(operation);
  } else {
    closedReceipt = asRecoveryClosed(operation);
  }
  await cleanupRecoveredClosedRuntimePromotion(operation, closedReceipt);
  return recoveredTerminalResult({
    journal: operation.journal,
    authored: operation.authoredSummary,
    cleanupPending: false,
    startedAt: input.startedAt,
    now: input.dependencies.now,
  });
}

function recoveryErrorResult(input: {
  readonly error: unknown;
  readonly state: {
    readonly journal?: RuntimePromotionJournal;
    readonly operation?: RuntimePromotionRecoveryOperation;
  };
  readonly startedAt: number;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly leaseDisposition: { releaseSafe: boolean };
}): RuntimeAdoptionResult {
  const operation = input.state.operation;
  if (isRuntimeManifestReleaseUnsafe(input.error)) {
    input.leaseDisposition.releaseSafe = false;
  }
  if (input.error instanceof RuntimePromotionDatastoreError && !input.error.releaseSafe) {
    input.leaseDisposition.releaseSafe = false;
  }
  let closedJournal: RuntimePromotionJournal | undefined;
  if (operation?.receipt.state === 'closed') {
    closedJournal = operation.journal;
  } else if (input.state.journal?.state === 'closed') {
    closedJournal = input.state.journal;
  }
  if (closedJournal?.terminal !== null && closedJournal?.terminal !== undefined) {
    return recoveredTerminalResult({
      journal: closedJournal,
      authored: operation?.authoredSummary ?? null,
      cleanupPending: !(operation?.journalUnlinked ?? false),
      startedAt: input.startedAt,
      now: input.dependencies.now,
    });
  }
  return recoveryFailure({
    ...(input.state.journal === undefined ? {} : { journal: input.state.journal }),
    ...(operation === undefined ? {} : { operation }),
    startedAt: input.startedAt,
    dependencies: input.dependencies,
    reasonCode: recoveryFailureReason(input.error, input.state.journal),
  });
}

async function runRecoveryWithLease(input: {
  readonly request: RecoverRuntimePromotionInput;
  readonly start: Extract<RecoveryStart, { readonly status: 'ready' }>;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly startedAt: number;
  readonly lease: RuntimeExclusiveLease;
}): Promise<RuntimeAdoptionResult> {
  const leaseDisposition = { releaseSafe: true };
  const state: {
    journal?: RuntimePromotionJournal;
    operation?: RuntimePromotionRecoveryOperation;
  } = {};
  try {
    input.dependencies.checkpoint?.('after-lease-acquired');
    return await executeRecoveryUnderLease({
      request: input.request,
      projectRoot: input.start.projectRoot,
      operationId: input.start.operationId,
      dependencies: input.dependencies,
      startedAt: input.startedAt,
      lease: input.lease,
      leaseDisposition,
      state,
    });
  } catch (error) {
    return recoveryErrorResult({
      error,
      state,
      startedAt: input.startedAt,
      dependencies: input.dependencies,
      leaseDisposition,
    });
  } finally {
    if (leaseDisposition.releaseSafe) input.lease.release();
  }
}

/**
 * Reconcile the one fixed Init-promotion journal for a canonical project.
 *
 * The fixed header admits the exact recovery lease; only the full canonical
 * body may then select an owned path or mutation. Current renderers and Tool
 * defaults are intentionally absent from this API.
 */
export async function recoverRuntimePromotion(
  input: RecoverRuntimePromotionInput,
  dependencyOverrides: Partial<RuntimePromotionRecoveryDependencies> = {},
): Promise<RuntimeAdoptionResult> {
  const dependencies = defaultDependencies(dependencyOverrides);
  const startedAt = dependencies.now();
  const start = inspectRecoveryStart({
    request: input,
    dependencies,
    startedAt,
  });
  if (start.status === 'result') return start.result;
  const acquired = await acquireRecoveryLeaseOrResult({
    start,
    dependencies,
    startedAt,
  });
  if (acquired.status === 'result') return acquired.result;
  return runRecoveryWithLease({
    request: input,
    start,
    dependencies,
    startedAt,
    lease: acquired.lease,
  });
}
