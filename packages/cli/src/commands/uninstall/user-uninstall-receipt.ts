/**
 * Bounded user-uninstall receipt body helpers.
 *
 * Core validates only the recovery header (kind/version/state/operationId).
 * The CLI body is write-ahead phase state without absolute HOME paths.
 */

import { createHash, randomBytes } from 'node:crypto';

import { RUNTIME_RECOVERY_HEADER_VERSION } from '@opensip-cli/core';

export const USER_UNINSTALL_MARKER_BASENAME = '.opensip-user-uninstall-marker';
export const USER_UNINSTALL_TOMBSTONE_PREFIX = '.opensip-user-uninstall-tombstone-';

export type UserUninstallPhase =
  | 'marker-create-intent'
  | 'marker-created'
  | 'rename-intent'
  | 'renamed'
  | 'delete-intent'
  | 'deleted';

export interface UserUninstallReceiptBody {
  readonly kind: 'user-uninstall';
  readonly version: typeof RUNTIME_RECOVERY_HEADER_VERSION;
  readonly state: 'open' | 'closed';
  readonly operationId: string;
  readonly phase: UserUninstallPhase;
  /** Same-parent tombstone basename only — never an absolute path. */
  readonly tombstoneBasename: string;
  /** Fixed marker basename under the source/tombstone root. */
  readonly markerBasename: typeof USER_UNINSTALL_MARKER_BASENAME;
  /** Hex digest of the exclusive marker file content. */
  readonly markerDigest: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly reason?: string;
}

export function newOperationId(): string {
  // Core validateOperationId expects a bounded alphanumeric-ish id.
  return `uu-${randomBytes(12).toString('hex')}`;
}

export function newTombstoneBasename(operationId: string): string {
  // Host-generated same-parent basename; operationId already hex-safe.
  return `${USER_UNINSTALL_TOMBSTONE_PREFIX}${operationId.replace(/^uu-/, '')}`;
}

export function newMarkerContent(): Buffer {
  return randomBytes(32);
}

export function digestMarkerContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function buildOpenReceipt(args: {
  readonly operationId: string;
  readonly phase: UserUninstallPhase;
  readonly tombstoneBasename: string;
  readonly markerDigest: string;
  readonly createdAtMs?: number;
  readonly reason?: string;
}): UserUninstallReceiptBody {
  const now = args.createdAtMs ?? Date.now();
  return {
    kind: 'user-uninstall',
    version: RUNTIME_RECOVERY_HEADER_VERSION,
    state: 'open',
    operationId: args.operationId,
    phase: args.phase,
    tombstoneBasename: args.tombstoneBasename,
    markerBasename: USER_UNINSTALL_MARKER_BASENAME,
    markerDigest: args.markerDigest,
    createdAtMs: now,
    updatedAtMs: now,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  };
}

export function advanceReceipt(
  receipt: UserUninstallReceiptBody,
  phase: UserUninstallPhase,
  extras: Partial<Pick<UserUninstallReceiptBody, 'markerDigest' | 'reason'>> = {},
): UserUninstallReceiptBody {
  return {
    ...receipt,
    phase,
    updatedAtMs: Date.now(),
    ...(extras.markerDigest === undefined ? {} : { markerDigest: extras.markerDigest }),
    ...(extras.reason === undefined ? {} : { reason: extras.reason }),
  };
}

export function closeReceipt(receipt: UserUninstallReceiptBody): UserUninstallReceiptBody {
  return {
    ...receipt,
    state: 'closed',
    phase: 'deleted',
    updatedAtMs: Date.now(),
  };
}

export function serializeReceipt(receipt: UserUninstallReceiptBody): string {
  return `${JSON.stringify(receipt)}\n`;
}

export function parseReceiptBody(content: string): UserUninstallReceiptBody | undefined {
  try {
    const parsed = JSON.parse(content) as Partial<UserUninstallReceiptBody>;
    if (
      parsed.kind !== 'user-uninstall' ||
      parsed.version !== RUNTIME_RECOVERY_HEADER_VERSION ||
      (parsed.state !== 'open' && parsed.state !== 'closed') ||
      typeof parsed.operationId !== 'string' ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.tombstoneBasename !== 'string' ||
      parsed.markerBasename !== USER_UNINSTALL_MARKER_BASENAME ||
      typeof parsed.markerDigest !== 'string'
    ) {
      return undefined;
    }
    return parsed as UserUninstallReceiptBody;
  } catch {
    return undefined;
  }
}
