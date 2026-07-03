import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  REVIEW_BRIEF_VERSION,
  buildReviewBriefBaselineDelta,
  buildReviewBriefCorrelations,
  buildReviewBriefRecommendedActions,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  pushReviewBriefDegradation,
  reviewBriefBaselineState,
  reviewBriefBlastRadius,
  signalToReviewBriefRisk,
  reviewBriefSchema,
  type ReviewBrief,
  type ReviewBriefDegradation,
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
    ...(input.entities === undefined ? {} : { entities: input.entities }),
    ...(input.correlationKeys === undefined ? {} : { correlationKeys: input.correlationKeys }),
  };
}

function keyedCorrelationRisk(
  kind: NonNullable<ReviewBriefRisk['correlationKeys']>[number]['kind'],
  value: string,
  index: number,
  blastDependents?: number,
): ReviewBriefRisk {
  return risk({
    severity: 'medium',
    file: `src/${String(index)}.ts`,
    signalRef: {
      tool: 'fit',
      suiteRunId: 'suite_1',
      stepIndex: index,
      signalIndex: 0,
      runId: `FIT_${String(index)}`,
      fingerprint: `fp-${String(index)}`,
    },
    ...(blastDependents === undefined
      ? {}
      : { blastRadius: { dependents: blastDependents, confidence: 'high' } }),
    correlationKeys: [{ kind, value, confidence: 'high' }],
  });
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

  it('uses column, rule, fingerprint, and signal indices as final tie-breaks', () => {
    const risks = [
      risk({
        severity: 'medium',
        column: 3,
        ruleId: 'rule-b',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 1,
          fingerprint: 'fp-b',
          signalIndex: 1,
        },
      }),
      risk({
        severity: 'medium',
        column: 1,
        ruleId: 'rule-a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          fingerprint: 'fp-b',
          signalIndex: 1,
        },
      }),
      risk({
        severity: 'medium',
        column: 1,
        ruleId: 'rule-a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          fingerprint: 'fp-a',
          signalIndex: 2,
        },
      }),
      risk({
        severity: 'medium',
        column: 1,
        ruleId: 'rule-a',
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: 0,
          fingerprint: 'fp-a',
          signalIndex: 1,
        },
      }),
    ].sort(compareReviewBriefRisks);

    expect(
      risks.map((r) => [
        r.column,
        r.ruleId,
        r.signalRef.fingerprint,
        r.signalRef.stepIndex,
        r.signalRef.signalIndex,
      ]),
    ).toEqual([
      [1, 'rule-a', 'fp-a', 0, 1],
      [1, 'rule-a', 'fp-a', 0, 2],
      [1, 'rule-a', 'fp-b', 0, 1],
      [3, 'rule-b', 'fp-b', 1, 1],
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

describe('review brief projection helpers', () => {
  it('derives baseline state from both flat and nested metadata shapes', () => {
    const added = createSignal({
      source: 'fit',
      ruleId: 'rule',
      severity: 'medium',
      message: 'finding',
      code: { file: 'src/a.ts' },
      metadata: { baselineState: 'new' },
    });
    const unchanged = createSignal({
      source: 'fit',
      ruleId: 'rule',
      severity: 'medium',
      message: 'finding',
      code: { file: 'src/a.ts' },
      metadata: { baseline: { state: 'existing' } },
    });
    const unknown = createSignal({
      source: 'fit',
      ruleId: 'rule',
      severity: 'medium',
      message: 'finding',
      code: { file: 'src/a.ts' },
      metadata: { baseline: 'bad' },
    });

    expect(reviewBriefBaselineState(added)).toBe('added');
    expect(reviewBriefBaselineState(unchanged)).toBe('unchanged');
    expect(reviewBriefBaselineState(unknown)).toBeUndefined();
    expect(
      reviewBriefBaselineState(
        createSignal({
          source: 'fit',
          ruleId: 'rule',
          severity: 'medium',
          message: 'finding',
          code: { file: 'src/a.ts' },
          metadata: { baselineState: 'unchanged' },
        }),
      ),
    ).toBe('unchanged');
    expect(
      reviewBriefBaselineState(
        createSignal({
          source: 'fit',
          ruleId: 'rule',
          severity: 'medium',
          message: 'finding',
          code: { file: 'src/a.ts' },
          metadata: { baseline: { state: 'new' } },
        }),
      ),
    ).toBe('added');
  });

  it('parses blast radius only when the metadata is complete and bounded', () => {
    const valid = createSignal({
      source: 'graph',
      ruleId: 'graph:blast',
      severity: 'high',
      message: 'blast',
      code: { file: 'src/a.ts' },
      metadata: {
        blastRadius: { dependents: 4, impactedFiles: 2, confidence: 'high' },
      },
    });
    const invalid = createSignal({
      source: 'graph',
      ruleId: 'graph:blast',
      severity: 'high',
      message: 'blast',
      code: { file: 'src/a.ts' },
      metadata: {
        blastRadius: { dependents: -1, confidence: 'guess' },
      },
    });

    expect(reviewBriefBlastRadius(valid)).toEqual({
      dependents: 4,
      impactedFiles: 2,
      confidence: 'high',
    });
    expect(reviewBriefBlastRadius(invalid)).toBeUndefined();
  });

  it('builds baseline deltas, recommended actions, and bounded degradations', () => {
    expect(buildReviewBriefBaselineDelta([], [])).toEqual({
      available: false,
      added: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(
      buildReviewBriefBaselineDelta(
        [risk({ severity: 'high', isNew: true }), risk({ severity: 'medium', isNew: false })],
        ['added', 'unchanged'],
      ),
    ).toEqual({
      available: true,
      added: 1,
      removed: 0,
      unchanged: 1,
    });

    expect(
      buildReviewBriefRecommendedActions({
        verdict: 'fail',
        risks: [risk({ severity: 'high' })],
        degraded: [],
      }),
    ).toEqual([
      {
        priority: 'high',
        source: 'suite',
        message: 'Review and fix the error-severity top risks before merging.',
      },
    ]);
    expect(
      buildReviewBriefRecommendedActions({
        verdict: 'warn',
        risks: [risk({ severity: 'low' })],
        degraded: [{ source: 'graph', reason: 'partial' }],
      }).map((action) => action.priority),
    ).toEqual(['medium', 'high']);
    expect(
      buildReviewBriefRecommendedActions({ verdict: 'pass', risks: [], degraded: [] }),
    ).toEqual([]);
    expect(
      buildReviewBriefRecommendedActions({
        verdict: 'fail',
        risks: [],
        degraded: [{ source: 'fit', reason: 'missing envelope' }],
      }),
    ).toEqual([
      {
        priority: 'medium',
        source: 'suite',
        message: 'Resolve degraded suite evidence and rerun the suite.',
      },
    ]);

    const degraded: ReviewBriefDegradation[] = [];
    pushReviewBriefDegradation(degraded, { source: 'fit', reason: 'first' }, 1);
    pushReviewBriefDegradation(degraded, { source: 'graph', reason: 'second' }, 1);
    expect(degraded).toEqual([{ source: 'fit', reason: 'first' }]);
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
        actions: [
          {
            id: 'add-reason',
            kind: 'add-suppression-reason',
            title: 'Add suppression reason',
            autofixable: false,
            confidence: 0.6,
            verification: {
              commands: ['opensip fit --check typescript-directive-hygiene'],
            },
            target: {
              filePath: 'src/a.ts',
              line: 1,
              checkSlug: 'typescript-directive-hygiene',
            },
          },
        ],
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
      correlatedRisks: [
        {
          id: 'corr-symbol-src-a',
          title: 'Related findings for symbol src/a.handler',
          severity: 'high',
          isNew: true,
          primary: {
            source: finding.source,
            ruleId: finding.ruleId,
            file: finding.file,
            line: finding.line,
            column: finding.column,
            signalRef: finding.signalRef,
          },
          members: [
            {
              source: finding.source,
              ruleId: finding.ruleId,
              file: finding.file,
              line: finding.line,
              column: finding.column,
              signalRef: finding.signalRef,
            },
          ],
          entities: [
            {
              kind: 'symbol',
              id: 'src/a.handler',
              label: 'src/a.handler',
              confidence: 'high',
            },
          ],
          reasons: [
            {
              kind: 'same-symbol',
              key: { kind: 'symbol', value: 'src/a.handler', confidence: 'high' },
              confidence: 'high',
              message: "Risks share symbol correlation key 'src/a.handler'.",
            },
          ],
        },
      ],
    };

    expect(reviewBriefSchema.parse(brief)).toEqual(brief);
  });

  it('accepts the previous v1 payload without correlation fields', () => {
    const finding = risk({ severity: 'medium' });
    const brief: ReviewBrief = {
      version: REVIEW_BRIEF_VERSION,
      suite: 'audit',
      suiteRunId: 'suite_1',
      verdict: 'warn',
      changedFiles: null,
      topRisks: [finding],
      newFindings: [],
      baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
      degraded: [],
      recommendedActions: [],
    };

    expect(reviewBriefSchema.parse(brief)).toEqual(brief);
  });

  it('rejects malformed nested repair and action payloads', () => {
    const finding = risk({
      severity: 'medium',
      repair: {
        autofixable: true,
        actions: [
          {
            id: 'bad-action',
            kind: 'text-replacement',
            title: 'Bad action',
            autofixable: true,
            verification: { commands: ['opensip fit'], extra: true } as never,
          },
        ],
      },
    });
    const brief: ReviewBrief = {
      version: REVIEW_BRIEF_VERSION,
      suite: 'audit',
      suiteRunId: 'suite_1',
      verdict: 'warn',
      changedFiles: 1,
      topRisks: [finding],
      newFindings: [],
      baselineDelta: { available: true, added: 0, removed: 0, unchanged: 1 },
      degraded: [
        { source: 'fit', reason: 'partial', code: 'impact-verification-partial', stepIndex: 0 },
      ],
      recommendedActions: [
        { priority: 'low', message: 'Inspect', command: 'opensip suite run audit' },
      ],
    };

    expect(() => reviewBriefSchema.parse(brief)).toThrow();
  });
});

function stamped(signal: Signal, fingerprint = 'fp-a'): Signal {
  return { ...signal, fingerprint };
}

describe('review brief correlation inputs', () => {
  it('derives entity refs and prioritized correlation keys from signal metadata', () => {
    const signal = stamped(
      createSignal({
        source: 'graph',
        ruleId: 'graph:cycle',
        severity: 'high',
        message: 'cycle',
        code: { file: 'src/a.ts', line: 10, column: 2 },
        metadata: {
          qualifiedName: 'src/a.handler',
          sccId: 'scc:1',
          packages: ['pkg-a', 'pkg-b'],
        },
      }),
    );

    const projected = signalToReviewBriefRisk({
      suiteRunId: 'suite_1',
      stepIndex: 0,
      signalIndex: 0,
      signal,
      tool: 'graph',
      runId: 'GRAPH_1',
    });

    expect(projected.entities?.map((entity) => [entity.kind, entity.id])).toEqual(
      expect.arrayContaining([
        ['fingerprint', 'fp-a'],
        ['file', 'src/a.ts'],
        ['file-range', 'src/a.ts:10:2'],
        ['symbol', 'src/a.handler'],
        ['graph-node', 'scc:scc:1'],
        ['package', 'pkg-a'],
      ]),
    );
    expect(
      projected.entities?.find((entity) => entity.kind === 'package' && entity.id === 'pkg-a')
        ?.source,
    ).toBe('metadata.packages');
    expect(
      projected.entities?.find((entity) => entity.kind === 'package' && entity.id === 'src')
        ?.source,
    ).toBe('signal.filePath');
    expect(projected.correlationKeys?.map((key) => key.kind).slice(0, 4)).toEqual([
      'fingerprint',
      'graph-node',
      'symbol',
      'rule-location',
    ]);
  });

  it('ignores malformed metadata and caps hostile arrays', () => {
    const signal = stamped(
      createSignal({
        source: 'graph',
        ruleId: 'graph:large-function',
        severity: 'medium',
        message: 'large',
        code: { file: 'src/a.ts', line: 1 },
        metadata: {
          qualifiedName: { nested: 'bad' },
          bodyHash: 'x'.repeat(500),
          packages: Array.from({ length: 30 }, (_, index) => `pkg-${String(index)}`),
          package: '/absolute/package',
        },
      }),
    );

    const projected = signalToReviewBriefRisk({
      suiteRunId: 'suite_1',
      stepIndex: 0,
      signalIndex: 0,
      signal,
      tool: 'graph',
      runId: 'GRAPH_1',
    });

    expect(projected.entities?.some((entity) => entity.id === '[object Object]')).toBe(false);
    expect(projected.entities?.some((entity) => entity.id === '/absolute/package')).toBe(false);
    expect(projected.entities?.length).toBeLessThanOrEqual(12);
    expect(projected.correlationKeys?.length).toBeLessThanOrEqual(12);
  });
});

describe('buildReviewBriefCorrelations', () => {
  it('groups risks by shared high-confidence keys without removing raw evidence', () => {
    const first = risk({
      severity: 'high',
      source: 'fit',
      ruleId: 'fit-rule',
      file: 'src/a.ts',
      signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
      entities: [{ kind: 'symbol', id: 'src/a.handler', confidence: 'high' }],
      correlationKeys: [{ kind: 'symbol', value: 'src/a.handler', confidence: 'high' }],
    });
    const second = risk({
      severity: 'medium',
      source: 'graph',
      ruleId: 'graph:large-function',
      file: 'src/a.ts',
      signalRef: { tool: 'graph', suiteRunId: 'suite_1', stepIndex: 1, signalIndex: 0 },
      entities: [{ kind: 'symbol', id: 'src/a.handler', confidence: 'high' }],
      correlationKeys: [{ kind: 'symbol', value: 'src/a.handler', confidence: 'high' }],
    });

    const groups = buildReviewBriefCorrelations([second, first]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.primary.signalRef.tool).toBe('fit');
    expect(groups[0]?.members.map((member) => member.signalRef.tool)).toEqual(['fit', 'graph']);
    expect(groups[0]?.reasons[0]?.kind).toBe('same-symbol');
  });

  it('does not group risks by similar messages without explicit keys', () => {
    const groups = buildReviewBriefCorrelations([
      risk({ severity: 'medium', message: 'same text', file: 'src/a.ts' }),
      risk({ severity: 'medium', message: 'same text', file: 'src/b.ts' }),
    ]);

    expect(groups).toEqual([]);
  });

  it('keeps the strongest explanation for the same member set', () => {
    const first = risk({
      severity: 'high',
      file: 'src/a.ts',
      signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
      correlationKeys: [
        { kind: 'symbol', value: 'src/a.handler', confidence: 'high' },
        { kind: 'file', value: 'src/a.ts', confidence: 'low' },
      ],
    });
    const second = risk({
      severity: 'high',
      file: 'src/a.ts',
      signalRef: { tool: 'graph', suiteRunId: 'suite_1', stepIndex: 1, signalIndex: 0 },
      correlationKeys: [
        { kind: 'symbol', value: 'src/a.handler', confidence: 'high' },
        { kind: 'file', value: 'src/a.ts', confidence: 'low' },
      ],
    });

    const groups = buildReviewBriefCorrelations([first, second]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reasons[0]?.kind).toBe('same-symbol');
  });

  it('applies group and member limits deterministically', () => {
    const risks = Array.from({ length: 5 }, (_, index) =>
      risk({
        severity: index === 4 ? 'high' : 'medium',
        file: `src/${String(index)}.ts`,
        signalRef: {
          tool: 'fit',
          suiteRunId: 'suite_1',
          stepIndex: index,
          signalIndex: 0,
        },
        correlationKeys: [
          { kind: 'package', value: 'pkg-a', confidence: 'low' },
          { kind: 'file', value: `src/${String(index)}.ts`, confidence: 'low' },
        ],
      }),
    );

    const groups = buildReviewBriefCorrelations(risks, { groupLimit: 1, memberLimit: 2 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
    expect(groups[0]?.severity).toBe('high');
  });

  it('orders equal-priority groups by member count and explains specialized keys', () => {
    const risks = [
      keyedCorrelationRisk('symbol', 'src/b.handler', 0),
      keyedCorrelationRisk('symbol', 'src/b.handler', 1),
      keyedCorrelationRisk('symbol', 'src/a.handler', 2),
      keyedCorrelationRisk('symbol', 'src/a.handler', 3),
      keyedCorrelationRisk('symbol', 'src/a.handler', 4),
      keyedCorrelationRisk('graph-node', 'node:handler', 5),
      keyedCorrelationRisk('graph-node', 'node:handler', 6),
      keyedCorrelationRisk('file-range', 'src/a.ts:1-5', 7),
      keyedCorrelationRisk('file-range', 'src/a.ts:1-5', 8),
      keyedCorrelationRisk('fingerprint', 'shared-fp', 9, 2),
      keyedCorrelationRisk('fingerprint', 'shared-fp', 10, 7),
      keyedCorrelationRisk('rule-location', 'rule-a@src/a.ts:1', 11),
      keyedCorrelationRisk('rule-location', 'rule-a@src/a.ts:1', 12),
    ];

    const groups = buildReviewBriefCorrelations(risks);
    const symbolGroups = groups.filter((group) => group.id.startsWith('corr-symbol-'));
    const titles = groups.map((group) => group.title);

    expect(symbolGroups.map((group) => group.members.length)).toEqual([3, 2]);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Related findings for graph node node:handler',
        'Related findings at src/a.ts:1-5',
        'Repeated evidence for fingerprint shared-fp',
        'Related findings at rule-a@src/a.ts:1',
      ]),
    );
    expect(groups.find((group) => group.id === 'corr-fingerprint-shared-fp')?.blastRadius).toEqual({
      dependents: 7,
      confidence: 'high',
    });
  });
});
