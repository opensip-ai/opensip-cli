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
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MARKER_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_REASON_BYTES = 96;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is UserUninstallPhase {
  return (
    value === 'marker-create-intent' ||
    value === 'marker-created' ||
    value === 'rename-intent' ||
    value === 'renamed' ||
    value === 'delete-intent' ||
    value === 'deleted'
  );
}

export function parseReceiptBody(content: string): UserUninstallReceiptBody | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.kind !== 'user-uninstall' ||
      parsed.version !== RUNTIME_RECOVERY_HEADER_VERSION ||
      (parsed.state !== 'open' && parsed.state !== 'closed') ||
      typeof parsed.operationId !== 'string' ||
      !OPERATION_ID_PATTERN.test(parsed.operationId) ||
      !isPhase(parsed.phase) ||
      parsed.tombstoneBasename !== newTombstoneBasename(parsed.operationId) ||
      parsed.markerBasename !== USER_UNINSTALL_MARKER_BASENAME ||
      typeof parsed.markerDigest !== 'string' ||
      !MARKER_DIGEST_PATTERN.test(parsed.markerDigest) ||
      typeof parsed.createdAtMs !== 'number' ||
      !Number.isSafeInteger(parsed.createdAtMs) ||
      parsed.createdAtMs < 0 ||
      typeof parsed.updatedAtMs !== 'number' ||
      !Number.isSafeInteger(parsed.updatedAtMs) ||
      parsed.updatedAtMs < 0 ||
      (parsed.reason !== undefined &&
        (typeof parsed.reason !== 'string' ||
          Buffer.byteLength(parsed.reason, 'utf8') > MAX_REASON_BYTES)) ||
      (parsed.state === 'closed' && parsed.phase !== 'deleted')
    ) {
      return undefined;
    }
    return {
      kind: parsed.kind,
      version: parsed.version,
      state: parsed.state,
      operationId: parsed.operationId,
      phase: parsed.phase,
      tombstoneBasename: parsed.tombstoneBasename,
      markerBasename: parsed.markerBasename,
      markerDigest: parsed.markerDigest,
      createdAtMs: parsed.createdAtMs,
      updatedAtMs: parsed.updatedAtMs,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    };
  } catch {
    return undefined;
  }
}
