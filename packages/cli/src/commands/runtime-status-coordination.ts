/**
 * Lease-stable orchestration for the read-only runtime-status projection.
 */

import { getErrorCode } from './init/error-code.js';
import {
  buildRuntimeStatusContext,
  busyStatus,
  recoveryStatus,
  resolveStatusCoordination,
  type ExecuteRuntimeStatusInput,
  type RuntimeStatusContext,
  type RuntimeStatusCoordination,
} from './runtime-status-context.js';
import { completedStatus, inspectRuntimeStorage } from './runtime-status-projection.js';

import type { RuntimePromotionStatusInspection } from './init/runtime-promotion-status.js';
import type { RuntimeLeaseActivity, RuntimeStatusResult } from '@opensip-cli/contracts';
import type { RuntimeLeaseStateInspection, RuntimeReadLease } from '@opensip-cli/core';

type StableLeaseInspection = Extract<RuntimeLeaseStateInspection, { readonly status: 'stable' }>;

function leaseActivity(
  inspection: StableLeaseInspection,
  includesStatusReader: boolean,
  forceBusy: boolean,
): RuntimeLeaseActivity {
  const writerPending = inspection.writer !== 'none' || inspection.globalWriter !== 'none';
  return {
    activeReaders: Math.max(0, inspection.projectReaders - (includesStatusReader ? 1 : 0)),
    writerPending,
    busy: forceBusy || writerPending,
  };
}

function leaseBlockingStatus(
  context: RuntimeStatusContext,
  inspection: RuntimeLeaseStateInspection,
  includesStatusReader: boolean,
): RuntimeStatusResult | undefined {
  if (inspection.status === 'busy') return busyStatus(context);
  const activity = leaseActivity(inspection, includesStatusReader, true);
  if (
    inspection.userUninstall.status === 'malformed' ||
    (inspection.userUninstall.status === 'valid' && inspection.userUninstall.state === 'open') ||
    activity.writerPending
  ) {
    return busyStatus(context, activity);
  }
}

function promotionMatchesLeaseInspection(
  promotion: RuntimePromotionStatusInspection,
  inspection: StableLeaseInspection,
): boolean {
  if (promotion.status === 'absent') return inspection.promotion.status === 'absent';
  if (promotion.status === 'cleanup-pending') {
    return inspection.promotion.status === 'valid' && inspection.promotion.state === 'closed';
  }
  if (promotion.status === 'busy') return false;
  if (inspection.promotion.status === 'valid') return inspection.promotion.state === 'open';
  return inspection.promotion.status === 'malformed';
}

function samePromotionProjection(
  left: RuntimePromotionStatusInspection,
  right: RuntimePromotionStatusInspection,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'absent' || left.status === 'busy') return true;
  if (right.status === 'absent' || right.status === 'busy') return false;
  return (
    left.recoveryPhase === right.recoveryPhase &&
    left.recoveryReasonCode === right.recoveryReasonCode &&
    left.recoveryCommand === right.recoveryCommand &&
    (left.status !== 'cleanup-pending' ||
      (right.status === 'cleanup-pending' && left.sourcePreserved === right.sourcePreserved))
  );
}

function isBoundedCoordinationFailure(error: unknown): boolean {
  const code = getErrorCode(error);
  return (
    code === 'CONFIGURATION.RECOVERY_REQUIRED' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.BUSY' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.EXISTS' ||
    code === 'SYSTEM.RUNTIME_COORDINATION.UNSAFE' ||
    code === 'SYSTEM.RUNTIME_LEASE.CAPACITY' ||
    code === 'SYSTEM.RUNTIME_LEASE.CLEANUP_CAPACITY' ||
    code === 'TIMEOUT.RUNTIME_READ'
  );
}

async function inspectCoordination(
  coordination: RuntimeStatusCoordination,
  projectRoot: string,
): Promise<RuntimeLeaseStateInspection | undefined> {
  try {
    return await coordination.inspect(projectRoot);
  } catch (error) {
    if (isBoundedCoordinationFailure(error)) return;
    throw error;
  }
}

function inspectPromotion(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): RuntimePromotionStatusInspection | undefined {
  try {
    return coordination.inspectPromotion(context.project.projectRoot, context.coordinationKey);
  } catch (error) {
    if (isBoundedCoordinationFailure(error)) return;
    throw error;
  }
}

function promotionBlockingStatus(
  context: RuntimeStatusContext,
  inspection: StableLeaseInspection,
  projection: RuntimePromotionStatusInspection,
  includesStatusReader: boolean,
): RuntimeStatusResult | undefined {
  if (!promotionMatchesLeaseInspection(projection, inspection)) return busyStatus(context);
  if (projection.status === 'busy') return busyStatus(context);
  if (projection.status === 'recovery-required') {
    return recoveryStatus(
      context,
      projection,
      leaseActivity(inspection, includesStatusReader, true),
    );
  }
}

async function inspectRuntimeStorageUnderLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<RuntimeStatusResult> {
  const underLease = await inspectCoordination(coordination, context.project.projectRoot);
  if (underLease === undefined) return busyStatus(context);
  const blockedUnderLease = leaseBlockingStatus(context, underLease, true);
  if (blockedUnderLease !== undefined) return blockedUnderLease;
  if (underLease.status !== 'stable' || underLease.projectReaders < 1) {
    return busyStatus(context);
  }
  const initialPromotion = inspectPromotion(context, coordination);
  if (initialPromotion === undefined) return busyStatus(context);
  const promotionBlocked = promotionBlockingStatus(context, underLease, initialPromotion, true);
  if (promotionBlocked !== undefined) return promotionBlocked;

  const inspected = inspectRuntimeStorage(context);
  const finalInspection = await inspectCoordination(coordination, context.project.projectRoot);
  if (finalInspection === undefined) return busyStatus(context);
  const blockedAfterRead = leaseBlockingStatus(context, finalInspection, true);
  if (blockedAfterRead !== undefined) return blockedAfterRead;
  if (finalInspection.status !== 'stable' || finalInspection.projectReaders < 1) {
    return busyStatus(context);
  }
  const finalPromotion = inspectPromotion(context, coordination);
  if (finalPromotion === undefined) return busyStatus(context);
  const finalPromotionBlocked = promotionBlockingStatus(
    context,
    finalInspection,
    finalPromotion,
    true,
  );
  if (finalPromotionBlocked !== undefined) return finalPromotionBlocked;
  if (finalPromotion.status === 'busy' || finalPromotion.status === 'recovery-required') {
    return busyStatus(context);
  }

  return completedStatus(inspected, leaseActivity(finalInspection, true, false), finalPromotion);
}

function releaseStatusLease(lease: RuntimeReadLease): boolean {
  try {
    lease.release();
    return true;
  } catch {
    return false;
  }
}

function statusWithoutCoordination(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): RuntimeStatusResult {
  const inspected = inspectRuntimeStorage(context);
  if (coordination.rootPresence() !== 'absent') return busyStatus(context);
  return completedStatus(
    inspected,
    {
      activeReaders: 0,
      writerPending: false,
      busy: false,
    },
    { status: 'absent' },
  );
}

type StatusLeaseAcquisition =
  { readonly status: RuntimeStatusResult } | { readonly lease: RuntimeReadLease };

async function promotionProjectionRemainedStable(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
  promotion: RuntimePromotionStatusInspection,
): Promise<boolean> {
  const afterProjection = await inspectCoordination(coordination, context.project.projectRoot);
  if (
    afterProjection?.status !== 'stable' ||
    leaseBlockingStatus(context, afterProjection, false) !== undefined ||
    !promotionMatchesLeaseInspection(promotion, afterProjection)
  ) {
    return false;
  }
  const afterPromotion = inspectPromotion(context, coordination);
  return afterPromotion !== undefined && samePromotionProjection(promotion, afterPromotion);
}

async function acquireInspectedStatusLease(
  context: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
): Promise<StatusLeaseAcquisition> {
  const before = await inspectCoordination(coordination, context.project.projectRoot);
  if (before === undefined) return { status: busyStatus(context) };
  const blockedBefore = leaseBlockingStatus(context, before, false);
  if (blockedBefore !== undefined) return { status: blockedBefore };
  if (before.status !== 'stable') return { status: busyStatus(context) };

  const promotion = inspectPromotion(context, coordination);
  if (promotion === undefined) return { status: busyStatus(context) };
  const promotionBlocked = promotionBlockingStatus(context, before, promotion, false);
  if (promotionBlocked !== undefined) {
    if (!(await promotionProjectionRemainedStable(context, coordination, promotion))) {
      return { status: busyStatus(context) };
    }
    return { status: promotionBlocked };
  }

  try {
    return { lease: await coordination.acquireRead(context.project.projectRoot) };
  } catch (error) {
    if (!isBoundedCoordinationFailure(error)) throw error;
    const raced = await inspectCoordination(coordination, context.project.projectRoot);
    if (raced === undefined) return { status: busyStatus(context) };
    const blocked = leaseBlockingStatus(context, raced, false);
    return {
      status:
        blocked ??
        busyStatus(
          context,
          raced.status === 'stable' ? leaseActivity(raced, false, true) : undefined,
        ),
    };
  }
}

async function statusWithLease(
  input: ExecuteRuntimeStatusInput,
  initialContext: RuntimeStatusContext,
  coordination: RuntimeStatusCoordination,
  lease: RuntimeReadLease,
): Promise<RuntimeStatusResult> {
  let leasedContext = initialContext;
  try {
    leasedContext = buildRuntimeStatusContext(input, false);
    const result =
      lease.coordinationKey === leasedContext.coordinationKey
        ? await inspectRuntimeStorageUnderLease(leasedContext, coordination)
        : busyStatus(leasedContext);
    return releaseStatusLease(lease) ? result : busyStatus(leasedContext);
  } catch (error) {
    if (!releaseStatusLease(lease)) return busyStatus(leasedContext);
    throw error;
  }
}

/** Inspect local runtime storage without creating or opening any state. */
export async function executeRuntimeStatus(
  input: ExecuteRuntimeStatusInput,
): Promise<RuntimeStatusResult> {
  const context = buildRuntimeStatusContext(input);
  const coordination = resolveStatusCoordination(input.coordination);
  const rootPresence = coordination.rootPresence();

  if (rootPresence === 'unsafe') return busyStatus(context);
  if (rootPresence === 'absent') return statusWithoutCoordination(context, coordination);

  const acquisition = await acquireInspectedStatusLease(context, coordination);
  if ('status' in acquisition) return acquisition.status;
  return statusWithLease(input, context, coordination, acquisition.lease);
}
