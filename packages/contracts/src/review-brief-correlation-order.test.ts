import { describe, expect, it } from 'vitest';

import {
  compareCodePoint,
  compareReviewBriefCorrelationGroups,
  compareReviewBriefCorrelationRisks,
  reviewBriefCorrelationMemberSignature,
} from './review-brief-correlation-order.js';
import type {
  ReviewBriefCorrelationGroup,
  ReviewBriefCorrelationRisk,
  ReviewBriefRiskRef,
} from './review-brief-correlation-types.js';

function risk(overrides: Partial<ReviewBriefCorrelationRisk> = {}): ReviewBriefCorrelationRisk {
  return {
    source: 'fit',
    ruleId: 'rule-a',
    severity: 'medium',
    file: 'src/a.ts',
    line: 1,
    column: 1,
    isNew: false,
    signalRef: {
      tool: 'fit',
      suiteRunId: 'suite_1',
      stepIndex: 0,
      signalIndex: 0,
      runId: 'RUN_1',
      fingerprint: 'fp-a',
    },
    ...overrides,
  };
}

function member(overrides: Partial<ReviewBriefRiskRef> = {}): ReviewBriefRiskRef {
  return {
    source: 'fit',
    ruleId: 'rule-a',
    file: 'src/a.ts',
    signalRef: {
      tool: 'fit',
      suiteRunId: 'suite_1',
      stepIndex: 0,
      signalIndex: 0,
      runId: 'RUN_1',
      fingerprint: 'fp-a',
    },
    ...overrides,
  };
}

function group(
  overrides: Partial<ReviewBriefCorrelationGroup> & Pick<ReviewBriefCorrelationGroup, 'id'>,
): ReviewBriefCorrelationGroup {
  const primary = overrides.primary ?? member();
  return {
    title: overrides.title ?? overrides.id,
    severity: overrides.severity ?? 'medium',
    isNew: overrides.isNew ?? false,
    primary,
    members: overrides.members ?? [primary],
    entities: overrides.entities ?? [],
    reasons: overrides.reasons ?? [
      {
        kind: 'same-file',
        key: { kind: 'file', value: 'src/a.ts', confidence: 'high' },
        confidence: 'high',
        message: 'same file',
      },
    ],
    ...overrides,
  };
}

describe('compareCodePoint', () => {
  it('orders by raw code points including equality', () => {
    expect(compareCodePoint('a', 'b')).toBe(-1);
    expect(compareCodePoint('b', 'a')).toBe(1);
    expect(compareCodePoint('same', 'same')).toBe(0);
  });
});

describe('compareReviewBriefCorrelationRisks', () => {
  it('orders by severity, isNew, blast dependents, and location fields', () => {
    const risks = [
      risk({
        severity: 'low',
        isNew: true,
        source: 'z',
        file: 'src/z.ts',
        line: 9,
        column: 9,
        ruleId: 'z',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          signalIndex: 0,
          fingerprint: 'z',
        },
      }),
      risk({
        severity: 'high',
        isNew: false,
        blastRadius: { dependents: 1, confidence: 'low' },
        source: 'b',
        file: 'src/b.ts',
        line: 2,
        column: 2,
        ruleId: 'b',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          signalIndex: 0,
          fingerprint: 'b',
        },
      }),
      risk({
        severity: 'high',
        isNew: true,
        blastRadius: { dependents: 5, confidence: 'high' },
        source: 'a',
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: 'a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          signalIndex: 0,
          fingerprint: 'a',
        },
      }),
      risk({
        severity: 'high',
        isNew: false,
        blastRadius: { dependents: 5, confidence: 'high' },
        source: 'a',
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: 'a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          signalIndex: 0,
          fingerprint: 'a',
        },
      }),
    ].sort(compareReviewBriefCorrelationRisks);

    expect(risks.map((item) => [item.severity, item.isNew, item.blastRadius?.dependents])).toEqual([
      ['high', true, 5],
      ['high', false, 5],
      ['high', false, 1],
      ['low', true, undefined],
    ]);
  });

  it('uses missing line/column as MAX_SAFE_INTEGER and fingerprints as the final key', () => {
    const withLine = risk({ line: 1, column: 1, ruleId: 'same' });
    const missingLine = risk({
      line: undefined,
      column: undefined,
      ruleId: 'same',
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite_1',
        stepIndex: 0,
        signalIndex: 0,
        fingerprint: 'fp-later',
      },
    });
    expect(compareReviewBriefCorrelationRisks(withLine, missingLine)).toBeLessThan(0);

    const leftCol = risk({ line: 1, column: 1, ruleId: 'same' });
    const rightCol = risk({ line: 1, column: 3, ruleId: 'same' });
    expect(compareReviewBriefCorrelationRisks(leftCol, rightCol)).toBeLessThan(0);

    const ruleA = risk({ line: 1, column: 1, ruleId: 'a' });
    const ruleB = risk({ line: 1, column: 1, ruleId: 'b' });
    expect(compareReviewBriefCorrelationRisks(ruleA, ruleB)).toBeLessThan(0);

    const fpA = risk({
      line: 1,
      column: 1,
      ruleId: 'same',
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite_1',
        stepIndex: 0,
        signalIndex: 0,
        fingerprint: 'a',
      },
    });
    const fpB = risk({
      line: 1,
      column: 1,
      ruleId: 'same',
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite_1',
        stepIndex: 0,
        signalIndex: 0,
        fingerprint: 'b',
      },
    });
    expect(compareReviewBriefCorrelationRisks(fpA, fpB)).toBeLessThan(0);

    const noFp = risk({
      line: 1,
      column: 1,
      ruleId: 'same',
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite_1',
        stepIndex: 0,
        signalIndex: 0,
        fingerprint: undefined,
      },
    });
    expect(compareReviewBriefCorrelationRisks(noFp, fpA)).toBeLessThan(0);
  });

  it('orders by source and file when higher-priority keys match', () => {
    const left = risk({ source: 'fit', file: 'src/a.ts' });
    const rightSource = risk({ source: 'graph', file: 'src/a.ts' });
    const rightFile = risk({ source: 'fit', file: 'src/b.ts' });
    expect(compareReviewBriefCorrelationRisks(left, rightSource)).toBeLessThan(0);
    expect(compareReviewBriefCorrelationRisks(left, rightFile)).toBeLessThan(0);
  });
});

describe('compareReviewBriefCorrelationGroups', () => {
  it('orders by severity, isNew, reason priority, member count, then id', () => {
    const groups = [
      group({
        id: 'z-low',
        severity: 'low',
        isNew: true,
        members: [member(), member({ ruleId: 'b' })],
        reasons: [
          {
            kind: 'same-file',
            key: { kind: 'file', value: 'x', confidence: 'low' },
            confidence: 'low',
            message: 'file',
          },
        ],
      }),
      group({
        id: 'b-high',
        severity: 'high',
        isNew: false,
        members: [member()],
        reasons: [
          {
            kind: 'same-file',
            key: { kind: 'file', value: 'x', confidence: 'low' },
            confidence: 'low',
            message: 'file',
          },
        ],
      }),
      group({
        id: 'a-high',
        severity: 'high',
        isNew: true,
        members: [member(), member({ ruleId: 'b' }), member({ ruleId: 'c' })],
        reasons: [
          {
            kind: 'same-fingerprint',
            key: { kind: 'fingerprint', value: 'fp', confidence: 'high' },
            confidence: 'high',
            message: 'fp',
          },
        ],
      }),
      group({
        id: 'c-high',
        severity: 'high',
        isNew: true,
        members: [member(), member({ ruleId: 'b' })],
        reasons: [
          {
            kind: 'same-fingerprint',
            key: { kind: 'fingerprint', value: 'fp', confidence: 'high' },
            confidence: 'high',
            message: 'fp',
          },
        ],
      }),
    ].sort(compareReviewBriefCorrelationGroups);

    expect(groups.map((item) => item.id)).toEqual(['a-high', 'c-high', 'b-high', 'z-low']);
  });

  it('treats groups with no reasons as lowest reason priority', () => {
    const withReason = group({
      id: 'with',
      reasons: [
        {
          kind: 'same-file',
          key: { kind: 'file', value: 'src/a.ts', confidence: 'high' },
          confidence: 'high',
          message: 'file',
        },
      ],
    });
    const withoutReason = group({ id: 'without', reasons: [] });
    expect(compareReviewBriefCorrelationGroups(withReason, withoutReason)).toBeLessThan(0);
  });
});

describe('reviewBriefCorrelationMemberSignature', () => {
  it('builds a stable signature from sorted member signal refs including optional fields', () => {
    const signature = reviewBriefCorrelationMemberSignature(
      group({
        id: 'g',
        members: [
          member({
            signalRef: {
              tool: 'graph',
              suiteRunId: 'suite_2',
              stepIndex: 2,
              signalIndex: 1,
              // omit runId / fingerprint to exercise empty-string fallbacks
            },
          }),
          member({
            signalRef: {
              tool: 'fit',
              suiteRunId: 'suite_1',
              stepIndex: 0,
              signalIndex: 0,
              runId: 'RUN_1',
              fingerprint: 'fp-a',
            },
          }),
        ],
      }),
    );

    expect(signature).toContain('fit');
    expect(signature).toContain('graph');
    // Sorted by code point: fit… before graph…
    expect(signature.indexOf('fit')).toBeLessThan(signature.indexOf('graph'));
  });
});
