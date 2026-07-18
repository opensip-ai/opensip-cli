import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimePromotionJournal,
  createRuntimePromotionOwnedSlots,
  type RuntimePromotionJournal,
} from '../runtime-promotion-journal-schema.js';
import {
  recoveryBusyResult,
  recoveryInputConflictResult,
  recoveryRequiredFromJournal,
} from '../runtime-promotion-recovery-result.js';

const OPERATION_ID = 'recovery-result-source-disposition';
const SOURCE_DIGEST = 'a'.repeat(64);

function initialJournal(): RuntimePromotionJournal {
  return createInitialRuntimePromotionJournal({
    coordinationKey: 'b'.repeat(24),
    operationId: OPERATION_ID,
    recoveryOwnerToken: 'recovery-result-owner-token',
    route: 'keep-project',
    destinationParentPreexisting: true,
    destinationRuntimePreexisting: true,
    source: {
      classification: 'legacy',
      cacheKey: 'b'.repeat(24),
      generationDigest: null,
      markerSha256: SOURCE_DIGEST,
    },
    inputs: {
      conflict: 'keep-project',
      authoredMode: 'fresh',
      languages: ['typescript'],
      languageExplicit: false,
    },
    plan: {
      authoredDigest: 'c'.repeat(64),
      replayDigest: 'd'.repeat(64),
      mutationCount: 0,
    },
    owned: createRuntimePromotionOwnedSlots(OPERATION_ID),
    createdAt: 1,
  });
}

function sourceWindow(
  phase: 'authored-committed' | 'source-retired',
  pending: boolean,
): RuntimePromotionJournal {
  const journal = initialJournal();
  return {
    ...journal,
    progress: {
      ...journal.progress,
      phase,
      pendingIntent: pending
        ? {
            sequence: 1,
            kind: 'source-retire',
            slot: 'sourceTombstone',
            cursor: null,
            recordedAt: 2,
          }
        : null,
      lastPostcondition:
        phase === 'source-retired'
          ? {
              sequence: 1,
              kind: 'source-retire',
              slot: 'sourceTombstone',
              cursor: null,
              outcome: 'applied',
              recordedAt: 2,
            }
          : null,
    },
  };
}

const SOURCE_WINDOWS = [
  { name: 'before source retirement', journal: sourceWindow('authored-committed', false) },
  { name: 'during source retirement', journal: sourceWindow('authored-committed', true) },
  { name: 'after source retirement', journal: sourceWindow('source-retired', false) },
] as const;

describe('runtime promotion recovery result source disposition', () => {
  it('does not claim source preservation when a busy lease prevents inspection', () => {
    const result = recoveryBusyResult(10, () => 14);

    expect(result).toMatchObject({
      status: 'busy',
      durationMs: 4,
      reasonCode: 'lease-busy',
    });
    expect(result).not.toHaveProperty('sourcePreserved');
  });

  it.each(SOURCE_WINDOWS)(
    'does not infer source preservation from durable phase alone $name',
    ({ journal }) => {
      const conflict = recoveryInputConflictResult(journal, 10, () => 12);
      const failure = recoveryRequiredFromJournal({
        journal,
        startedAt: 10,
        now: () => 13,
      });

      expect(conflict).not.toHaveProperty('sourcePreserved');
      expect(failure).not.toHaveProperty('sourcePreserved');
    },
  );

  it('reports source preservation when the recovery caller supplies verified evidence', () => {
    const result = recoveryRequiredFromJournal({
      journal: sourceWindow('source-retired', false),
      sourcePreserved: true,
      startedAt: 10,
      now: () => 13,
    });

    expect(result.sourcePreserved).toBe(true);
  });
});
