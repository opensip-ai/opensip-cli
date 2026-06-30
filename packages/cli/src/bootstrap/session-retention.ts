import { logger as defaultLogger, type Logger } from '@opensip-cli/core';
import { SessionRepo } from '@opensip-cli/session-store';

import type { DataStore, DatastoreMaintenance } from '@opensip-cli/datastore';

const DAY_MS = 86_400_000;
const BYTES_PER_MB = 1024 * 1024;
const MODULE_TAG = 'cli:session-retention';

/** MUST match cliConfigSchema.sessions defaults in @opensip-cli/config. */
export const DEFAULT_SESSION_RETENTION_KEEP = 200;
export const DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS = 60;
export const DEFAULT_SESSION_RETENTION_MAX_SIZE_MB = 150;

export interface SessionRetentionPolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly maxSizeMb: number;
}

export interface EnforceSessionRetentionDeps {
  readonly now?: number;
  readonly logger?: Logger;
}

export function resolveSessionRetentionPolicy(
  configured?: Partial<SessionRetentionPolicy>,
): SessionRetentionPolicy {
  return {
    keep: normalizedNonNegativeInt(configured?.keep, DEFAULT_SESSION_RETENTION_KEEP),
    maxAgeDays: normalizedNonNegativeInt(
      configured?.maxAgeDays,
      DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
    ),
    maxSizeMb: normalizedNonNegativeInt(
      configured?.maxSizeMb,
      DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    ),
  };
}

function normalizedNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logFailure(log: Logger, operation: string, error: unknown): void {
  log.warn({
    evt: 'session.retention.failed',
    module: MODULE_TAG,
    operation,
    error: errorMessage(error),
  });
}

function safeWrite<T>(
  datastore: DataStore,
  operation: string,
  log: Logger,
  fn: () => T,
): T | undefined {
  try {
    return datastore.withWriteLock(operation, fn);
  } catch (error) {
    logFailure(log, operation, error);
    return undefined;
  }
}

function safeFileSizeBytes(maintenance: DatastoreMaintenance, log: Logger): number | undefined {
  try {
    return maintenance.fileSizeBytes();
  } catch (error) {
    logFailure(log, 'session.retention.file_size', error);
    return undefined;
  }
}

function vacuumFull(datastore: DataStore, maintenance: DatastoreMaintenance, log: Logger): boolean {
  const beforeBytes = safeFileSizeBytes(maintenance, log);
  const vacuumed = safeWrite(datastore, 'session.retention.full_vacuum', log, () => {
    maintenance.fullVacuum();
    return true;
  });
  if (vacuumed !== true) return false;
  const afterBytes = safeFileSizeBytes(maintenance, log);
  log.info({
    evt: 'session.retention.vacuumed',
    module: MODULE_TAG,
    beforeBytes: beforeBytes ?? null,
    afterBytes: afterBytes ?? null,
  });
  return true;
}

function reclaimIncremental(
  datastore: DataStore,
  maintenance: DatastoreMaintenance | undefined,
  deletedCount: number,
  log: Logger,
): void {
  if (deletedCount <= 0 || maintenance === undefined) return;
  const reclaimed = safeWrite(datastore, 'session.retention.incremental_vacuum', log, () => {
    maintenance.incrementalVacuum();
    return true;
  });
  if (reclaimed !== true) return;
  log.debug({
    evt: 'session.retention.reclaimed',
    module: MODULE_TAG,
    deletedCount,
  });
}

function enforceSizeGuard(
  datastore: DataStore,
  repo: SessionRepo,
  policy: SessionRetentionPolicy,
  log: Logger,
): void {
  const maintenance = datastore.maintenance;
  if (maintenance === undefined || policy.maxSizeMb <= 0) return;
  const limitBytes = policy.maxSizeMb * BYTES_PER_MB;
  const sizeBytes = safeFileSizeBytes(maintenance, log);
  if (sizeBytes === undefined || sizeBytes <= limitBytes) return;

  log.warn({
    evt: 'session.retention.oversize.warn',
    module: MODULE_TAG,
    sizeBytes,
    limitBytes,
  });

  if (!vacuumFull(datastore, maintenance, log)) return;
  const afterVacuumBytes = safeFileSizeBytes(maintenance, log);
  if (afterVacuumBytes === undefined || afterVacuumBytes <= limitBytes) return;
  if (policy.keep <= 1) return;

  const aggressiveKeep = Math.max(1, Math.floor(policy.keep / 2));
  let deletedCount = 0;
  try {
    if (repo.count() > aggressiveKeep) {
      deletedCount = repo.pruneToCount(aggressiveKeep);
      log.info({
        evt: 'session.retention.pruned',
        module: MODULE_TAG,
        reason: 'size',
        deletedCount,
        keptCount: aggressiveKeep,
      });
    }
  } catch (error) {
    logFailure(log, 'session.retention.size_prune', error);
    return;
  }
  if (deletedCount <= 0) return;
  vacuumFull(datastore, maintenance, log);
}

/**
 * Best-effort host-owned retention for persisted run sessions. A prune or
 * reclaim failure must never alter the primary tool verdict or exit code.
 */
export function enforceSessionRetention(
  datastore: DataStore,
  policy: SessionRetentionPolicy,
  deps: EnforceSessionRetentionDeps = {},
): void {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now();
  const repo = new SessionRepo(datastore);
  let deletedCount = 0;

  try {
    if (policy.keep > 0) {
      const count = repo.count();
      if (count > policy.keep) {
        const deleted = repo.pruneToCount(policy.keep);
        deletedCount += deleted;
        log.info({
          evt: 'session.retention.pruned',
          module: MODULE_TAG,
          reason: 'count',
          deletedCount: deleted,
          keptCount: Math.min(count - deleted, policy.keep),
        });
      }
    }

    if (policy.maxAgeDays > 0) {
      const cutoff = new Date(now - policy.maxAgeDays * DAY_MS);
      const deleted = repo.purge(cutoff);
      deletedCount += deleted;
      if (deleted > 0) {
        log.info({
          evt: 'session.retention.pruned',
          module: MODULE_TAG,
          reason: 'age',
          deletedCount: deleted,
          keptCount: repo.count(),
        });
      }
    }
  } catch (error) {
    logFailure(log, 'session.retention.prune', error);
    return;
  }

  reclaimIncremental(datastore, datastore.maintenance, deletedCount, log);
  enforceSizeGuard(datastore, repo, policy, log);
}
