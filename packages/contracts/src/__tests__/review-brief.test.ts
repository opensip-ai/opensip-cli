import { describe, expect, it } from 'vitest';

import {
  REVIEW_BRIEF_VERSION,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  reviewBriefSchema,
  type ReviewBrief,
  type ReviewBriefRisk,
} from '../index.js';

function risk(
  input: Partial<ReviewBriefRisk> & Pick<ReviewBriefRisk, 'severity'>,
): ReviewBriefRisk {
  return {
    source: input.source ?? 'fit',
    ruleId: input.ruleId ?? 'rule-a',
    message: input.message ?? 'finding',
    severity: input.severity,
    file: input.file ?? 'src/a.ts',
    line: input.line ?? 1,
    column: input.column ?? 0,
    isNew: input.isNew ?? false,
    signalRef: {
      tool: input.signalRef?.tool ?? 'fit',
      suiteRunId: input.signalRef?.suiteRunId ?? 'suite_1',
      stepIndex: input.signalRef?.stepIndex ?? 0,
      runId: input.signalRef?.runId ?? 'FIT_1',
      fingerprint: input.signalRef?.fingerprint ?? 'fp-a',
      signalIndex: input.signalRef?.signalIndex ?? 0,
    },
    ...(input.repair === undefined ? {} : { repair: input.repair }),
    ...(input.blastRadius === undefined ? {} : { blastRadius: input.blastRadius }),
    ...(input.dedupedRefs === undefined ? {} : { dedupedRefs: input.dedupedRefs }),
  };
}

describe('ReviewBrief ranking', () => {
  it('orders error-severity risks ahead of warning-severity risks', () => {
    const risks = [
      risk({ severity: 'low' }),
      risk({ severity: 'critical' }),
      risk({ severity: 'medium' }),
      risk({ severity: 'high' }),
    ].sort(compareReviewBriefRisks);

    expect(risks.map((r) => r.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('orders new findings ahead of unchanged findings at the same severity', () => {
    const risks = [
      risk({ severity: 'medium', isNew: false, ruleId: 'a' }),
      risk({ severity: 'medium', isNew: true, ruleId: 'b' }),
    ].sort(compareReviewBriefRisks);

    expect(risks.map((r) => r.isNew)).toEqual([true, false]);
  });

  it('uses blast radius and stable source location tie-breaks deterministically', () => {
    const risks = [
      risk({
        severity: 'high',
        source: 'graph',
        file: 'src/b.ts',
        line: 4,
        ruleId: 'rule-b',
        signalRef: { tool: 'graph', suiteRunId: 'suite_1', stepIndex: 1, signalIndex: 0 },
        blastRadius: { dependents: 2, confidence: 'medium' },
      }),
      risk({
        severity: 'high',
        source: 'fit',
        file: 'src/a.ts',
        line: 2,
        ruleId: 'rule-a',
        signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
        blastRadius: { dependents: 8, confidence: 'high' },
      }),
      risk({
        severity: 'high',
        source: 'fit',
        file: 'src/a.ts',
        line: 1,
        ruleId: 'rule-a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          fingerprint: 'fp-a',
          signalIndex: 1,
        },
        blastRadius: { dependents: 2, confidence: 'high' },
      }),
    ].sort(compareReviewBriefRisks);

    expect(risks.map((r) => [r.source, r.file, r.line, r.blastRadius?.dependents])).toEqual([
      ['fit', 'src/a.ts', 2, 8],
      ['fit', 'src/a.ts', 1, 2],
      ['graph', 'src/b.ts', 4, 2],
    ]);
  });
});

describe('deriveReviewBriefVerdict', () => {
  it('maps error-severity findings to fail', () => {
    expect(deriveReviewBriefVerdict({ risks: [risk({ severity: 'high' })] })).toBe('fail');
  });

  it('maps warning-severity findings to warn', () => {
    expect(deriveReviewBriefVerdict({ risks: [risk({ severity: 'medium' })] })).toBe('warn');
  });

  it('maps degraded-only evidence to warn', () => {
    expect(deriveReviewBriefVerdict({ degraded: [{ source: 'graph' }] })).toBe('warn');
  });

  it('maps empty clean runs to pass', () => {
    expect(deriveReviewBriefVerdict({ risks: [], degraded: [] })).toBe('pass');
  });
});

describe('reviewBriefSchema', () => {
  it('validates the v1 payload shape', () => {
    const finding = risk({
      severity: 'high',
      isNew: true,
      repair: {
        repairKind: 'manual',
        autofixable: false,
        patchHint: { kind: 'text', summary: 'Inspect the failing rule.' },
      },
    });
    const brief: ReviewBrief = {
      version: REVIEW_BRIEF_VERSION,
      suite: 'security',
      suiteRunId: 'suite_1',
      verdict: 'fail',
      changedFiles: null,
      topRisks: [finding],
      newFindings: [finding],
      baselineDelta: { available: true, added: 1, removed: 0, unchanged: 0 },
      degraded: [],
      recommendedActions: [
        {
          priority: 'high',
          message: 'Inspect the failing review brief risks.',
          source: 'suite',
        },
      ],
    };

    expect(reviewBriefSchema.parse(brief)).toEqual(brief);
  });
});
