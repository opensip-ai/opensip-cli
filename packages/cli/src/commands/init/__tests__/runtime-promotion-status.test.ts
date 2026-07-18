import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalRuntimePromotionJournal,
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  encodeRuntimePromotionJournal,
  type RuntimePromotionJournal,
  type RuntimePromotionPendingIntent,
  type RuntimePromotionPhase,
} from '../runtime-promotion-journal-schema.js';
import {
  inspectRuntimePromotionStatus,
  projectRuntimePromotionRecoveryPhase,
  type RuntimePromotionStatusDependencies,
} from '../runtime-promotion-status.js';

import type { RuntimeRecoveryPhase } from '@opensip-cli/contracts';
import type { RecoveryHeaderInspection } from '@opensip-cli/core';

const PROJECT_KEY = 'a'.repeat(24);
const OTHER_KEY = 'b'.repeat(24);
const OPERATION_ID = 'status-operation-000000000001';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function initialJournal(
  overrides: {
    readonly coordinationKey?: string;
    readonly sourceBacked?: boolean;
  } = {},
): RuntimePromotionJournal {
  const sourceBacked = overrides.sourceBacked ?? false;
  return createInitialRuntimePromotionJournal({
    coordinationKey: overrides.coordinationKey ?? PROJECT_KEY,
    operationId: OPERATION_ID,
    recoveryOwnerToken: 'status-owner-000000000000001',
    route: sourceBacked ? 'promote-cache' : 'authored-only',
    destinationParentPreexisting: sourceBacked,
    destinationRuntimePreexisting: false,
    destinationRootIdentity: null,
    source: sourceBacked
      ? {
          classification: 'generation-bound',
          cacheKey: 'c'.repeat(24),
          generationDigest: 'c'.repeat(64),
          markerSha256: 'd'.repeat(64),
          rootIdentity: { device: '1', inode: '2' },
        }
      : {
          classification: 'none',
          cacheKey: null,
          generationDigest: null,
          markerSha256: null,
          rootIdentity: null,
        },
    inputs: {
      conflict: sourceBacked ? 'use-cache' : 'abort',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: DIGEST_A,
      replayDigest: DIGEST_B,
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 100,
  });
}

function closedRolledBackJournal(): RuntimePromotionJournal {
  const initial = initialJournal();
  const rollbackStarted = canonicalRuntimePromotionJournal({
    ...initial,
    revision: 1,
    progress: {
      ...initial.progress,
      phase: 'rollback-started',
      direction: 'rollback',
    },
    timestamps: { ...initial.timestamps, updatedAt: 101 },
  });
  const authoredRolledBack = canonicalRuntimePromotionJournal({
    ...rollbackStarted,
    revision: 2,
    progress: { ...rollbackStarted.progress, phase: 'authored-rolled-back' },
    timestamps: { ...rollbackStarted.timestamps, updatedAt: 102 },
  });
  const sealed = canonicalRuntimePromotionJournal({
    ...authoredRolledBack,
    revision: 3,
    progress: { ...authoredRolledBack.progress, phase: 'rolled-back' },
    terminal: {
      outcome: 'rolled-back',
      authority: 'none',
      runtimeManifest: null,
      authoredVerified: true,
      sourcePreserved: false,
      verifiedAt: 103,
    },
    timestamps: { ...authoredRolledBack.timestamps, updatedAt: 103 },
  });
  return canonicalRuntimePromotionJournal({
    ...sealed,
    state: 'closed',
    revision: 4,
    progress: { ...sealed.progress, phase: 'closed', direction: 'cleanup' },
    timestamps: { ...sealed.timestamps, updatedAt: 104, closedAt: 104 },
  });
}

function keepProjectJournal(): RuntimePromotionJournal {
  const journal = initialJournal({ sourceBacked: true });
  return canonicalRuntimePromotionJournal({
    ...journal,
    route: 'keep-project',
    destinationRuntimePreexisting: true,
    destinationRootIdentity: { device: '3', inode: '4' },
    inputs: { ...journal.inputs, conflict: 'keep-project' },
  });
}

function header(
  journal: RuntimePromotionJournal,
): Extract<RecoveryHeaderInspection, { readonly status: 'valid' }> {
  return {
    status: 'valid',
    state: journal.state,
    operationId: journal.operationId,
  };
}

function observed(journal: RuntimePromotionJournal) {
  const content = encodeRuntimePromotionJournal(journal);
  return {
    status: 'present' as const,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function inspectWith(input: {
  readonly headers: readonly RecoveryHeaderInspection[];
  readonly journal?: RuntimePromotionJournal;
  readonly content?: string;
}) {
  let headerIndex = 0;
  const dependencies: RuntimePromotionStatusDependencies = {
    coordinationKeyForProject: () => PROJECT_KEY,
    inspectHeader: () =>
      input.headers[Math.min(headerIndex++, input.headers.length - 1)] ?? {
        status: 'absent',
      },
    readJournal: () => {
      if (input.content !== undefined) {
        return {
          status: 'present',
          content: input.content,
          sha256: createHash('sha256').update(input.content).digest('hex'),
        };
      }
      return input.journal === undefined ? { status: 'absent' } : observed(input.journal);
    },
  };
  return inspectRuntimePromotionStatus({
    projectRoot: '/private/project-that-must-not-escape',
    coordinationKey: PROJECT_KEY,
    dependencies,
  });
}

function phaseJournal(
  phase: RuntimePromotionPhase,
  direction: RuntimePromotionJournal['progress']['direction'] = 'forward',
  pendingIntent: RuntimePromotionPendingIntent | null = null,
): Pick<RuntimePromotionJournal, 'progress'> {
  return {
    progress: {
      phase,
      direction,
      runtimeInstallState: 'not-installed',
      authoredCursor: 0,
      rollbackCursor: 0,
      pendingIntent,
      lastPostcondition: null,
    },
  };
}

describe('runtime promotion status projection', () => {
  it.each([
    ['prepared', 'prepared'],
    ['source-verified', 'source-verification'],
    ['destination-verified', 'source-verification'],
    ['authored-prepared', 'authored-prepare'],
    ['destination-ready', 'runtime-staging'],
    ['runtime-staged', 'runtime-staging'],
    ['destination-backed-up', 'destination-backup'],
    ['runtime-installed', 'destination-install'],
    ['authored-committed', 'authored-commit'],
    ['source-retired', 'source-retirement'],
    ['authority-verified', 'source-retirement'],
    ['committed', 'cleanup'],
  ] as const)('maps idle forward phase %s to %s', (phase, expected: RuntimeRecoveryPhase) => {
    expect(projectRuntimePromotionRecoveryPhase(phaseJournal(phase))).toBe(expected);
  });

  it.each([
    ['runtime-stage-create', 'runtime-staging'],
    ['destination-parent-create', 'runtime-staging'],
    ['destination-backup-create', 'destination-backup'],
    ['destination-install', 'destination-install'],
    ['authored-prepare', 'authored-prepare'],
    ['authored-target-commit', 'authored-commit'],
    ['source-retire', 'source-retirement'],
    ['runtime-rollback', 'rollback'],
    ['authored-target-rollback', 'rollback'],
    ['owned-slot-cleanup', 'cleanup'],
  ] as const)('maps pending intent %s to %s', (kind, expected: RuntimeRecoveryPhase) => {
    expect(
      projectRuntimePromotionRecoveryPhase(
        phaseJournal('prepared', 'forward', {
          sequence: 1,
          kind,
          slot: null,
          cursor: null,
          recordedAt: 101,
        }),
      ),
    ).toBe(expected);
  });

  it('lets rollback and cleanup direction dominate stale internal phase detail', () => {
    expect(projectRuntimePromotionRecoveryPhase(phaseJournal('rollback-started', 'rollback'))).toBe(
      'rollback',
    );
    expect(projectRuntimePromotionRecoveryPhase(phaseJournal('closed', 'cleanup'))).toBe('cleanup');
  });

  it.each([
    'rollback-started',
    'runtime-rolled-back',
    'authored-rolled-back',
    'rolled-back',
  ] as const)('maps open rollback phase %s to rollback', (phase) => {
    expect(projectRuntimePromotionRecoveryPhase(phaseJournal(phase, 'rollback'))).toBe('rollback');
  });

  it('classifies a valid open rollback as an operation failure', () => {
    const initial = initialJournal();
    const rollback = canonicalRuntimePromotionJournal({
      ...initial,
      revision: 1,
      progress: {
        ...initial.progress,
        phase: 'rollback-started',
        direction: 'rollback',
      },
      timestamps: { ...initial.timestamps, updatedAt: 101 },
    });

    expect(
      inspectWith({
        headers: [header(rollback), header(rollback)],
        journal: rollback,
      }),
    ).toEqual({
      status: 'recovery-required',
      recoveryPhase: 'rollback',
      recoveryReasonCode: 'operation-failed',
      recoveryCommand: 'opensip init',
    });
  });

  it('projects a canonical open journal with its exact safe retry and no source guess', () => {
    const journal = initialJournal({ sourceBacked: true });
    const result = inspectWith({
      headers: [header(journal), header(journal)],
      journal,
    });

    expect(result).toEqual({
      status: 'recovery-required',
      recoveryPhase: 'prepared',
      recoveryReasonCode: 'operation-interrupted',
      recoveryCommand: 'opensip init --runtime-conflict use-cache',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sourcePreserved');
    expect(serialized).not.toContain(OPERATION_ID);
    expect(serialized).not.toContain('status-owner');
    expect(serialized).not.toContain(DIGEST_A);
    expect(serialized).not.toContain('/private/');
  });

  it('preserves an exact keep-project retry without exposing journal authority', () => {
    const journal = keepProjectJournal();
    expect(inspectWith({ headers: [header(journal), header(journal)], journal })).toEqual({
      status: 'recovery-required',
      recoveryPhase: 'prepared',
      recoveryReasonCode: 'operation-interrupted',
      recoveryCommand: 'opensip init --runtime-conflict keep-project',
    });
  });

  it.each([
    ['oversize', 'journal-oversize'],
    ['coordination-key-mismatch', 'journal-key-mismatch'],
    ['invalid-json', 'journal-malformed'],
    ['invalid-header', 'journal-malformed'],
    ['unsafe-file', 'state-ambiguous'],
  ] as const)('maps a stable malformed header %s without reading the body', (reason, expected) => {
    let reads = 0;
    const result = inspectRuntimePromotionStatus({
      projectRoot: '/private/project',
      coordinationKey: PROJECT_KEY,
      dependencies: {
        coordinationKeyForProject: () => PROJECT_KEY,
        inspectHeader: () => ({ status: 'malformed', reason }),
        readJournal: () => {
          reads++;
          return { status: 'absent' };
        },
      },
    });

    expect(result).toMatchObject({
      status: 'recovery-required',
      recoveryPhase: 'unknown',
      recoveryReasonCode: expected,
    });
    expect(reads).toBe(0);
  });

  it('rejects a canonical journal for another key and an impossible full body', () => {
    const foreign = initialJournal({ coordinationKey: OTHER_KEY });
    expect(
      inspectWith({
        headers: [header(foreign), header(foreign)],
        journal: foreign,
      }),
    ).toMatchObject({
      status: 'recovery-required',
      recoveryReasonCode: 'journal-key-mismatch',
    });

    const current = initialJournal();
    expect(
      inspectWith({
        headers: [header(current), header(current)],
        content: JSON.stringify({
          kind: 'init-promotion',
          version: 1,
          coordinationKey: PROJECT_KEY,
          operationId: OPERATION_ID,
          state: 'open',
        }),
      }),
    ).toMatchObject({
      status: 'recovery-required',
      recoveryReasonCode: 'journal-phase-invalid',
    });
  });

  it('rejects caller key drift before reading any coordination record', () => {
    let headerReads = 0;
    let bodyReads = 0;
    expect(
      inspectRuntimePromotionStatus({
        projectRoot: '/private/project',
        coordinationKey: PROJECT_KEY,
        dependencies: {
          coordinationKeyForProject: () => OTHER_KEY,
          inspectHeader: () => {
            headerReads++;
            return { status: 'absent' };
          },
          readJournal: () => {
            bodyReads++;
            return { status: 'absent' };
          },
        },
      }),
    ).toMatchObject({
      status: 'recovery-required',
      recoveryReasonCode: 'journal-key-mismatch',
    });
    expect({ headerReads, bodyReads }).toEqual({
      headerReads: 0,
      bodyReads: 0,
    });
  });

  it.each(['closed', 'absent'] as const)(
    'fails a bracketed open-to-%s transition closed as busy',
    (next) => {
      const journal = initialJournal();
      const after: RecoveryHeaderInspection =
        next === 'absent' ? { status: 'absent' } : { ...header(journal), state: 'closed' };
      expect(inspectWith({ headers: [header(journal), after], journal })).toEqual({
        status: 'busy',
      });
    },
  );

  it('does not invent source disposition for a canonical source-free closed journal', () => {
    const journal = closedRolledBackJournal();
    const result = inspectWith({
      headers: [header(journal), header(journal)],
      journal,
    });

    expect(result).toEqual({
      status: 'cleanup-pending',
      recoveryPhase: 'cleanup',
      recoveryReasonCode: 'cleanup-pending',
      recoveryCommand: 'opensip init',
    });
    expect(result).not.toHaveProperty('sourcePreserved');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('terminal');
    expect(serialized).not.toContain('manifest');
    expect(serialized).not.toContain(OPERATION_ID);
  });

  it('keeps a stable closed header nonblocking when its full body cannot be trusted', () => {
    const journal = closedRolledBackJournal();
    const result = inspectWith({
      headers: [header(journal), header(journal)],
      content: '{"kind":"init-promotion","state":"closed"}',
    });

    expect(result).toEqual({
      status: 'cleanup-pending',
      recoveryPhase: 'cleanup',
      recoveryReasonCode: 'cleanup-pending',
      recoveryCommand: 'opensip init',
    });
    expect(result).not.toHaveProperty('sourcePreserved');
  });

  it.each(['absent', 'unsafe', 'foreign-body'] as const)(
    'keeps a stable closed header nonblocking across a %s body outcome',
    (outcome) => {
      const journal = closedRolledBackJournal();
      const result = inspectRuntimePromotionStatus({
        projectRoot: '/private/project',
        coordinationKey: PROJECT_KEY,
        dependencies: {
          coordinationKeyForProject: () => PROJECT_KEY,
          inspectHeader: () => header(journal),
          readJournal: () => {
            if (outcome === 'absent') return { status: 'absent' };
            if (outcome === 'unsafe') {
              throw Object.assign(new Error('unsafe'), {
                code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
              });
            }
            const foreign = encodeRuntimePromotionJournal(
              canonicalRuntimePromotionJournal({
                ...journal,
                coordinationKey: OTHER_KEY,
              }),
            );
            return {
              status: 'present',
              content: foreign,
              sha256: createHash('sha256').update(foreign).digest('hex'),
            };
          },
        },
      });

      expect(result).toEqual({
        status: 'cleanup-pending',
        recoveryPhase: 'cleanup',
        recoveryReasonCode: 'cleanup-pending',
        recoveryCommand: 'opensip init',
      });
    },
  );

  it('uses the Init journal bound rather than a wider core transport bound', () => {
    const journal = initialJournal();
    const oversized = JSON.stringify({
      kind: 'init-promotion',
      version: 1,
      coordinationKey: PROJECT_KEY,
      operationId: OPERATION_ID,
      state: 'open',
      padding: 'x'.repeat(24 * 1024),
    });

    expect(
      inspectWith({
        headers: [header(journal), header(journal)],
        content: oversized,
      }),
    ).toMatchObject({
      status: 'recovery-required',
      recoveryReasonCode: 'journal-oversize',
    });
  });

  it.each([
    'SYSTEM.RUNTIME_COORDINATION.BUSY',
    'SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH',
  ] as const)('maps an anchored publication race (%s) to busy', (code) => {
    const journal = initialJournal();
    expect(
      inspectRuntimePromotionStatus({
        projectRoot: '/private/project',
        coordinationKey: PROJECT_KEY,
        dependencies: {
          coordinationKeyForProject: () => PROJECT_KEY,
          inspectHeader: () => header(journal),
          readJournal: () => {
            throw Object.assign(new Error('changed'), {
              code,
            });
          },
        },
      }),
    ).toEqual({ status: 'busy' });
  });

  it('maps an anchored unsafe read to ambiguous state for open recovery', () => {
    const journal = initialJournal();
    expect(
      inspectRuntimePromotionStatus({
        projectRoot: '/private/project',
        coordinationKey: PROJECT_KEY,
        dependencies: {
          coordinationKeyForProject: () => PROJECT_KEY,
          inspectHeader: () => header(journal),
          readJournal: () => {
            throw Object.assign(new Error('unsafe'), {
              code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE',
            });
          },
        },
      }),
    ).toMatchObject({
      status: 'recovery-required',
      recoveryReasonCode: 'state-ambiguous',
    });
  });
});
