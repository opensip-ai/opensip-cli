import {
  currentScope,
  formatUnknownErrorMessage,
  logger as defaultLogger,
  type Logger,
} from '@opensip-cli/core';
import { RunRepo, SessionRepo } from '@opensip-cli/session-store';

import { loadCliDefaults } from './cli-defaults.js';

import type { DataStore, DatastoreMaintenance } from '@opensip-cli/datastore';
import type { RunRetentionBatchResult } from '@opensip-cli/session-store';

const DAY_MS = 86_400_000;
const BYTES_PER_MB = 1024 * 1024;
const MODULE_TAG = 'cli:evidence-retention';

/** Maximum rows selected by any one automatic retention transaction. */
export const EVIDENCE_RETENTION_BATCH_SIZE = 256;
/** Maximum bounded Session→parent-Run passes in one command finalizer. */
export const MAX_EVIDENCE_RETENTION_ITERATIONS = 32;

/** MUST match cliConfigSchema.sessions defaults in @opensip-cli/config. */
export const DEFAULT_SESSION_RETENTION_KEEP = 200;
export const DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS = 60;
export const DEFAULT_SESSION_RETENTION_MAX_SIZE_MB = 150;

export interface SessionRetentionPolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly maxSizeMb: number;
}

export type SessionRetentionPolicySource = 'scope' | 'cwd-fallback';

export interface ResolvedSessionRetentionPolicy extends SessionRetentionPolicy {
  readonly source: SessionRetentionPolicySource;
}

export interface EnforceSessionRetentionDeps {
  readonly now?: number;
  readonly logger?: Logger;
}

/**
 * Best-effort retention summary. `unresolvedProtected` means evidence retained
 * by the effective policy or a live Session link remains while the SQLite file
 * is over its advisory size target. `unresolvedNonEvidence` is true only when
 * no Session or parent-Run evidence remains, so unrelated governed tables are
 * what keep the whole database over that target.
 */
export interface EvidenceRetentionResult {
  readonly sessionsDeleted: number;
  readonly runsDeleted: number;
  readonly protectedRuns: number;
  readonly iterations: number;
  readonly sizeIterations: number;
  readonly iterationLimitHit: boolean;
  readonly finalSizeBytes?: number;
  readonly unresolvedProtected: boolean;
  readonly unresolvedNonEvidence: boolean;
}

interface MutableRetentionResult {
  sessionsDeleted: number;
  runsDeleted: number;
  protectedRuns: number;
  iterations: number;
  sizeIterations: number;
  iterationLimitHit: boolean;
  finalSizeBytes?: number;
  unresolvedProtected: boolean;
  unresolvedNonEvidence: boolean;
}

interface EvidenceRepos {
  readonly sessions: SessionRepo;
  readonly runs: RunRepo;
}

interface BatchPassResult {
  readonly deleted: number;
  readonly mayHaveMore: boolean;
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

export function resolveCurrentSessionRetentionPolicy(): ResolvedSessionRetentionPolicy {
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  const source: SessionRetentionPolicySource = projectRoot === undefined ? 'cwd-fallback' : 'scope';
  return {
    source,
    ...resolveSessionRetentionPolicy(loadCliDefaults(projectRoot ?? process.cwd()).sessions),
  };
}

function normalizedNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function logFailure(log: Logger, operation: string, error: unknown): void {
  log.warn({
    evt: 'evidence.retention.failed',
    module: MODULE_TAG,
    operation,
    error: formatUnknownErrorMessage(error),
  });
}

function safeOperation<T>(operation: string, log: Logger, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    logFailure(log, operation, error);
    return undefined;
  }
}

function safeWrite<T>(
  datastore: DataStore,
  operation: string,
  log: Logger,
  fn: () => T,
): T | undefined {
  return safeOperation(operation, log, () => datastore.withWriteLock(operation, fn));
}

function safeFileSizeBytes(maintenance: DatastoreMaintenance, log: Logger): number | undefined {
  return safeOperation('evidence.retention.file_size', log, () => maintenance.fileSizeBytes());
}

function vacuumFull(datastore: DataStore, maintenance: DatastoreMaintenance, log: Logger): boolean {
  const beforeBytes = safeFileSizeBytes(maintenance, log);
  const vacuumed = safeWrite(datastore, 'evidence.retention.full_vacuum', log, () => {
    maintenance.fullVacuum();
    return true;
  });
  if (vacuumed !== true) return false;
  const afterBytes = safeFileSizeBytes(maintenance, log);
  log.info({
    evt: 'evidence.retention.reclaimed',
    module: MODULE_TAG,
    mode: 'full',
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
  const reclaimed = safeWrite(datastore, 'evidence.retention.incremental_vacuum', log, () => {
    maintenance.incrementalVacuum();
    return true;
  });
  if (reclaimed !== true) return;
  log.debug({
    evt: 'evidence.retention.reclaimed',
    module: MODULE_TAG,
    mode: 'incremental',
    deletedCount,
  });
}

function logSessionPrune(log: Logger, reason: 'count' | 'age' | 'size', deleted: number): void {
  if (deleted <= 0) return;
  log.info({
    evt: 'evidence.retention.pruned',
    module: MODULE_TAG,
    layer: 'session',
    reason,
    deleted,
    protected: 0,
  });
}

function recordRunPrune(
  result: RunRetentionBatchResult | undefined,
  reason: 'count' | 'age' | 'size',
  summary: MutableRetentionResult,
  log: Logger,
): BatchPassResult {
  if (result === undefined) return { deleted: 0, mayHaveMore: false };
  summary.runsDeleted += result.deleted;
  summary.protectedRuns = Math.max(summary.protectedRuns, result.protected);
  if (result.deleted > 0 || result.protected > 0) {
    log.info({
      evt: 'evidence.retention.pruned',
      module: MODULE_TAG,
      layer: 'run',
      reason,
      examined: result.examined,
      deleted: result.deleted,
      protected: result.protected,
      remainingEligible: result.remainingEligible,
    });
  }
  return {
    deleted: result.deleted,
    mayHaveMore: result.remainingEligible > 0,
  };
}

/**
 * Run one short bounded Session-first pass, followed immediately by parent-Run
 * pruning. Each repository method owns its own write lock and transaction.
 */
function runRetentionPass(
  repos: EvidenceRepos,
  policy: Pick<SessionRetentionPolicy, 'keep' | 'maxAgeDays'>,
  cutoff: Date | undefined,
  summary: MutableRetentionResult,
  log: Logger,
  reason: 'policy' | 'size',
): BatchPassResult {
  let deleted = 0;
  let mayHaveMore = false;
  const sessionReason = reason === 'size' ? 'size' : 'count';

  if (policy.keep > 0) {
    const sessionDeleted = safeOperation('evidence.retention.session_count', log, () =>
      repos.sessions.pruneToCountBatch(policy.keep, EVIDENCE_RETENTION_BATCH_SIZE),
    );
    if (sessionDeleted !== undefined) {
      summary.sessionsDeleted += sessionDeleted;
      deleted += sessionDeleted;
      mayHaveMore ||= sessionDeleted === EVIDENCE_RETENTION_BATCH_SIZE;
      logSessionPrune(log, sessionReason, sessionDeleted);
    }
  }

  if (policy.maxAgeDays > 0 && cutoff !== undefined) {
    const sessionDeleted = safeOperation('evidence.retention.session_age', log, () =>
      repos.sessions.purgeBatch(cutoff, EVIDENCE_RETENTION_BATCH_SIZE),
    );
    if (sessionDeleted !== undefined) {
      summary.sessionsDeleted += sessionDeleted;
      deleted += sessionDeleted;
      mayHaveMore ||= sessionDeleted === EVIDENCE_RETENTION_BATCH_SIZE;
      logSessionPrune(log, 'age', sessionDeleted);
    }
  }

  if (policy.keep > 0) {
    const runResult = safeOperation('evidence.retention.run_count', log, () =>
      repos.runs.pruneToCountBatch(policy.keep, EVIDENCE_RETENTION_BATCH_SIZE),
    );
    const recorded = recordRunPrune(runResult, reason === 'size' ? 'size' : 'count', summary, log);
    deleted += recorded.deleted;
    mayHaveMore ||= recorded.mayHaveMore;
  }

  if (policy.maxAgeDays > 0 && cutoff !== undefined) {
    const runResult = safeOperation('evidence.retention.run_age', log, () =>
      repos.runs.pruneOlderThanBatch(cutoff, EVIDENCE_RETENTION_BATCH_SIZE),
    );
    const recorded = recordRunPrune(runResult, 'age', summary, log);
    deleted += recorded.deleted;
    mayHaveMore ||= recorded.mayHaveMore;
  }

  return { deleted, mayHaveMore };
}

function enforcePolicyBounds(
  repos: EvidenceRepos,
  policy: SessionRetentionPolicy,
  cutoff: Date | undefined,
  summary: MutableRetentionResult,
  log: Logger,
): number {
  if (policy.keep <= 0 && policy.maxAgeDays <= 0) return 0;
  let deleted = 0;
  for (let index = 0; index < MAX_EVIDENCE_RETENTION_ITERATIONS; index += 1) {
    const pass = runRetentionPass(repos, policy, cutoff, summary, log, 'policy');
    summary.iterations += 1;
    deleted += pass.deleted;
    if (pass.deleted === 0 && !pass.mayHaveMore) return deleted;
    if (index === MAX_EVIDENCE_RETENTION_ITERATIONS - 1) {
      summary.iterationLimitHit = pass.deleted > 0 || pass.mayHaveMore;
    }
  }
  return deleted;
}

function classifyUnresolvedOversize(
  repos: EvidenceRepos,
  summary: MutableRetentionResult,
  log: Logger,
): void {
  const sessionCount = safeOperation('evidence.retention.count_sessions', log, () =>
    repos.sessions.count(),
  );
  const runCount = safeOperation('evidence.retention.count_runs', log, () =>
    repos.runs.countRuns(),
  );
  if (sessionCount === undefined || runCount === undefined) return;
  const evidenceRemains = sessionCount > 0 || runCount > 0;
  summary.unresolvedProtected = evidenceRemains;
  summary.unresolvedNonEvidence = !evidenceRemains;
}

function runSizePressurePruning(
  datastore: DataStore,
  maintenance: DatastoreMaintenance,
  repos: EvidenceRepos,
  policy: SessionRetentionPolicy,
  cutoff: Date | undefined,
  limitBytes: number,
  summary: MutableRetentionResult,
  log: Logger,
): number | undefined {
  const aggressiveKeep = policy.keep > 1 ? Math.max(1, Math.floor(policy.keep / 2)) : policy.keep;
  if (aggressiveKeep <= 0 || policy.keep <= 1) return summary.finalSizeBytes;

  let sizeBytes = summary.finalSizeBytes;
  for (let index = 0; index < MAX_EVIDENCE_RETENTION_ITERATIONS; index += 1) {
    const pass = runRetentionPass(
      repos,
      { keep: aggressiveKeep, maxAgeDays: policy.maxAgeDays },
      cutoff,
      summary,
      log,
      'size',
    );
    summary.sizeIterations += 1;
    reclaimIncremental(datastore, maintenance, pass.deleted, log);
    sizeBytes = safeFileSizeBytes(maintenance, log);
    summary.finalSizeBytes = sizeBytes;
    if (sizeBytes === undefined || sizeBytes <= limitBytes) return sizeBytes;
    if (pass.deleted === 0 && !pass.mayHaveMore) return sizeBytes;
    if (index === MAX_EVIDENCE_RETENTION_ITERATIONS - 1) {
      summary.iterationLimitHit ||= pass.deleted > 0 || pass.mayHaveMore;
    }
  }
  return sizeBytes;
}

function enforceSizeGuard(
  datastore: DataStore,
  repos: EvidenceRepos,
  policy: SessionRetentionPolicy,
  cutoff: Date | undefined,
  summary: MutableRetentionResult,
  log: Logger,
): void {
  const maintenance = datastore.maintenance;
  if (maintenance === undefined || policy.maxSizeMb <= 0) return;
  const limitBytes = policy.maxSizeMb * BYTES_PER_MB;
  let sizeBytes = safeFileSizeBytes(maintenance, log);
  summary.finalSizeBytes = sizeBytes;
  if (sizeBytes === undefined || sizeBytes <= limitBytes) return;

  log.warn({
    evt: 'evidence.retention.oversize',
    module: MODULE_TAG,
    sizeBytes,
    limitBytes,
  });

  if (!vacuumFull(datastore, maintenance, log)) return;
  sizeBytes = safeFileSizeBytes(maintenance, log);
  summary.finalSizeBytes = sizeBytes;
  if (sizeBytes === undefined || sizeBytes <= limitBytes) return;

  sizeBytes = runSizePressurePruning(
    datastore,
    maintenance,
    repos,
    policy,
    cutoff,
    limitBytes,
    summary,
    log,
  );
  if (sizeBytes === undefined || sizeBytes <= limitBytes) return;

  // Fold free pages left by the final bounded batch before the final verdict.
  if (!vacuumFull(datastore, maintenance, log)) return;
  sizeBytes = safeFileSizeBytes(maintenance, log);
  summary.finalSizeBytes = sizeBytes;
  if (sizeBytes === undefined || sizeBytes <= limitBytes) return;

  classifyUnresolvedOversize(repos, summary, log);
  log.warn({
    evt: 'evidence.retention.oversize_unresolved',
    module: MODULE_TAG,
    sizeBytes,
    limitBytes,
    unresolvedProtected: summary.unresolvedProtected,
    unresolvedNonEvidence: summary.unresolvedNonEvidence,
    iterationLimitHit: summary.iterationLimitHit,
  });
}

/**
 * Best-effort host-owned retention for persisted Session and parent-Run
 * evidence. Failures never alter the primary tool verdict or exit code.
 */
export function enforceSessionRetention(
  datastore: DataStore,
  policy: SessionRetentionPolicy,
  deps: EnforceSessionRetentionDeps = {},
): EvidenceRetentionResult {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now();
  const repos: EvidenceRepos = {
    sessions: new SessionRepo(datastore),
    runs: new RunRepo(datastore),
  };
  const summary: MutableRetentionResult = {
    sessionsDeleted: 0,
    runsDeleted: 0,
    protectedRuns: 0,
    iterations: 0,
    sizeIterations: 0,
    iterationLimitHit: false,
    unresolvedProtected: false,
    unresolvedNonEvidence: false,
  };
  const cutoff = policy.maxAgeDays > 0 ? new Date(now - policy.maxAgeDays * DAY_MS) : undefined;

  const deleted = enforcePolicyBounds(repos, policy, cutoff, summary, log);
  reclaimIncremental(datastore, datastore.maintenance, deleted, log);
  enforceSizeGuard(datastore, repos, policy, cutoff, summary, log);
  return summary;
}
