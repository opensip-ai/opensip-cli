import { basename } from 'node:path';

import { hasErrorCode } from './error-code.js';
import {
  recoveryBusyResult,
  recoveryRequiredFromJournal,
} from './runtime-promotion-recovery-result.js';

import type {
  RecoverRuntimePromotionInput,
  RuntimePromotionRecoveryDependencies,
} from './runtime-promotion-recovery-types.js';
import type { RuntimeAdoptionResult } from '@opensip-cli/contracts';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

export const RECOVERY_STATE_AMBIGUOUS = 'state-ambiguous' as const;

function isLeaseBusy(error: unknown): boolean {
  return (
    hasErrorCode(error, 'TIMEOUT.RUNTIME_EXCLUSIVE') ||
    hasErrorCode(error, 'SYSTEM.RUNTIME_COORDINATION.BUSY')
  );
}

function malformedHeaderReason(
  reason:
    'oversize' | 'unsafe-file' | 'invalid-json' | 'invalid-header' | 'coordination-key-mismatch',
): 'journal-malformed' | 'journal-oversize' | 'journal-key-mismatch' | 'state-ambiguous' {
  if (reason === 'oversize') return 'journal-oversize';
  if (reason === 'coordination-key-mismatch') return 'journal-key-mismatch';
  if (reason === 'unsafe-file') return RECOVERY_STATE_AMBIGUOUS;
  return 'journal-malformed';
}

async function acquireRecoveryLease(input: {
  readonly projectRoot: string;
  readonly operationId: string;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
}): Promise<RuntimeExclusiveLease> {
  return input.dependencies.acquireLease({
    projectDir: input.projectRoot,
    posture: 'init-recovery',
    recoveryOperationId: input.operationId,
    command: 'opensip init',
    cwdBasename: basename(input.projectRoot),
  });
}

export type RecoveryStart =
  | {
      readonly status: 'ready';
      readonly projectRoot: string;
      readonly operationId: string;
    }
  | { readonly status: 'result'; readonly result: RuntimeAdoptionResult };

export function inspectRecoveryStart(input: {
  readonly request: RecoverRuntimePromotionInput;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly startedAt: number;
}): RecoveryStart {
  let projectRoot: string;
  try {
    projectRoot = input.dependencies.canonicalizeProjectRoot(input.request.projectRoot);
  } catch {
    return {
      status: 'result',
      result: recoveryRequiredFromJournal({
        reasonCode: RECOVERY_STATE_AMBIGUOUS,
        startedAt: input.startedAt,
        now: input.dependencies.now,
      }),
    };
  }
  if (projectRoot !== input.request.projectRoot) {
    return {
      status: 'result',
      result: recoveryRequiredFromJournal({
        reasonCode: RECOVERY_STATE_AMBIGUOUS,
        startedAt: input.startedAt,
        now: input.dependencies.now,
      }),
    };
  }
  const header = input.dependencies.inspectHeader(projectRoot);
  input.dependencies.checkpoint?.('after-header-inspection');
  if (header.status === 'absent') {
    return {
      status: 'result',
      result: recoveryRequiredFromJournal({
        reasonCode: RECOVERY_STATE_AMBIGUOUS,
        startedAt: input.startedAt,
        now: input.dependencies.now,
      }),
    };
  }
  if (header.status === 'malformed') {
    return {
      status: 'result',
      result: recoveryRequiredFromJournal({
        reasonCode: malformedHeaderReason(header.reason),
        startedAt: input.startedAt,
        now: input.dependencies.now,
      }),
    };
  }
  return { status: 'ready', projectRoot, operationId: header.operationId };
}

export async function acquireRecoveryLeaseOrResult(input: {
  readonly start: Extract<RecoveryStart, { readonly status: 'ready' }>;
  readonly dependencies: RuntimePromotionRecoveryDependencies;
  readonly startedAt: number;
}): Promise<
  | { readonly status: 'ready'; readonly lease: RuntimeExclusiveLease }
  | { readonly status: 'result'; readonly result: RuntimeAdoptionResult }
> {
  try {
    return {
      status: 'ready',
      lease: await acquireRecoveryLease({
        projectRoot: input.start.projectRoot,
        operationId: input.start.operationId,
        dependencies: input.dependencies,
      }),
    };
  } catch (error) {
    return {
      status: 'result',
      result: isLeaseBusy(error)
        ? recoveryBusyResult(input.startedAt, input.dependencies.now)
        : recoveryRequiredFromJournal({
            reasonCode: RECOVERY_STATE_AMBIGUOUS,
            startedAt: input.startedAt,
            now: input.dependencies.now,
          }),
    };
  }
}
