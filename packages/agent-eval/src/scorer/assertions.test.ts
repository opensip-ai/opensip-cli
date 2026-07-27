import { describe, expect, it } from 'vitest';

import {
  makeStepRecord,
  type ArmLegRecord,
  type ArmRunRecord,
  type MakeStepRecordInput,
  type StepRecord,
} from '../model/record.js';

import { evaluateAssertions } from './assertions.js';

import type { AnswerAssertions, AnswerFact, Arm, RunLeg } from '../model/task.js';

const extractNothing = (): readonly AnswerFact[] => [];

function resolvedStep(id = 'lookup', expectedNonEmpty = false) {
  return {
    arguments: {},
    expectedNonEmpty,
    extract: extractNothing,
    id,
    provesAbsence: [
      { kind: 'package' as const, name: 'forbidden' },
      { kind: 'symbol' as const, name: 'removed' },
    ],
    rationale: 'Look up normalized facts.',
    tool: 'search',
  };
}

function step(
  leg: RunLeg,
  facts: readonly AnswerFact[],
  overrides: Partial<MakeStepRecordInput> = {},
): StepRecord {
  return makeStepRecord({
    completeness: 'complete',
    facts,
    leg,
    proofClosure: {
      domainExhausted: true,
      projectionComplete: true,
      reasonCodes: [],
    },
    renderedResponse: JSON.stringify(facts),
    step: resolvedStep(),
    wallMs: 5,
    ...overrides,
  });
}

function run(arm: Arm, legs: readonly ArmLegRecord[]): ArmRunRecord {
  return {
    arm,
    legs,
    setup: {
      mode: 'fixture',
      stages: [{ durationMs: 100, exitCode: 0, name: 'init' }],
    },
    strategyVersion: 'v1',
    taskId: 'task',
  };
}

function oneLeg(arm: Arm, ...steps: readonly StepRecord[]): ArmRunRecord {
  return run(arm, [{ leg: 'main', steps }]);
}

const ordinaryAssertions: AnswerAssertions = {
  mustExclude: [{ kind: 'package', name: 'forbidden' }],
  mustInclude: [
    { kind: 'package', name: 'core' },
    { kind: 'text', label: 'package-manager', value: 'pnpm' },
  ],
};

describe('assertion evaluation', () => {
  it('scores normalized facts and complete negative evidence', () => {
    const result = evaluateAssertions(
      oneLeg(
        'opensip',
        step('main', [
          { kind: 'package', name: 'core' },
          { kind: 'text', label: 'package-manager', value: 'pnpm' },
        ]),
      ),
      ordinaryAssertions,
    );

    expect(result).toMatchObject({ incorrectNone: 0, passed: true });
    expect(result.scopes[0]?.outcomes).toHaveLength(3);
  });

  it('fails conflicting facts and absence based on incomplete evidence', () => {
    const conflict = evaluateAssertions(
      oneLeg(
        'opensip',
        step('main', [
          { kind: 'package', name: 'core' },
          { kind: 'package', name: 'forbidden' },
          { kind: 'text', label: 'package-manager', value: 'pnpm' },
        ]),
      ),
      ordinaryAssertions,
    );
    const incomplete = evaluateAssertions(
      oneLeg(
        'opensip',
        step(
          'main',
          [
            { kind: 'package', name: 'core' },
            { kind: 'text', label: 'package-manager', value: 'pnpm' },
          ],
          { completeness: 'incomplete', truncated: true },
        ),
      ),
      ordinaryAssertions,
    );

    expect(conflict.passed).toBe(false);
    expect(incomplete.passed).toBe(false);
    expect(
      incomplete.scopes[0]?.outcomes.find((outcome) => outcome.kind === 'must-exclude'),
    ).toMatchObject({ passed: false });
  });

  it('does not borrow an unrelated complete step as proof of absence', () => {
    const result = evaluateAssertions(
      oneLeg(
        'control',
        step('main', [], {
          step: {
            ...resolvedStep('unrelated'),
            provesAbsence: [{ kind: 'file', path: 'src/other.ts' }],
          },
        }),
      ),
      { mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    );

    expect(result.passed).toBe(false);
    expect(result.scopes[0]?.outcomes[0]?.passed).toBe(false);
  });

  it('rejects a relevant proof while another page remains', () => {
    const result = evaluateAssertions(
      oneLeg(
        'opensip',
        step('main', [], {
          nextCursor: 'r1:more',
          step: resolvedStep('paged'),
        }),
      ),
      { mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    );

    expect(result.passed).toBe(false);
  });

  it('rejects a complete terminal absence proof derived from an incomplete frontier', () => {
    const result = evaluateAssertions(
      oneLeg(
        'control',
        step('main', [{ kind: 'text', label: 'caller-frontier', value: 'partial' }], {
          completeness: 'incomplete',
          step: {
            ...resolvedStep('discover-frontier', true),
            provesAbsence: [],
          },
          truncated: true,
        }),
        step('main', [], {
          step: {
            ...resolvedStep('search-derived-frontier'),
            provesAbsence: [{ kind: 'symbol', name: 'removed' }],
          },
        }),
      ),
      { mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    );

    expect(result.incorrectNone).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scopes[0]?.outcomes[0]?.passed).toBe(false);
  });

  it('rejects a closed terminal proof after an unattested projection step', () => {
    const result = evaluateAssertions(
      oneLeg(
        'control',
        step('main', [{ kind: 'text', label: 'frontier', value: 'candidate' }], {
          proofClosure: undefined,
          step: {
            ...resolvedStep('discover-frontier'),
            provesAbsence: [],
          },
        }),
        step('main', [], {
          step: {
            ...resolvedStep('search-frontier'),
            provesAbsence: [{ kind: 'symbol', name: 'removed' }],
          },
        }),
      ),
      { mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    );

    expect(result.passed).toBe(false);
    expect(result.scopes[0]?.outcomes[0]?.passed).toBe(false);
  });

  it('allows an explicitly irrelevant prefix step before a closed proof', () => {
    const result = evaluateAssertions(
      oneLeg(
        'control',
        step('main', [], {
          proofClosure: undefined,
          step: {
            ...resolvedStep('independent-setup'),
            proofRelevance: 'irrelevant',
            provesAbsence: [],
          },
        }),
        step('main', [], {
          step: {
            ...resolvedStep('search-frontier'),
            provesAbsence: [{ kind: 'symbol', name: 'removed' }],
          },
        }),
      ),
      { mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    );

    expect(result.passed).toBe(true);
  });

  it.each([
    ['missing closure', undefined],
    [
      'lossy projection',
      {
        domainExhausted: true,
        projectionComplete: false,
        reasonCodes: ['unresolved'],
      },
    ],
    [
      'open domain',
      {
        domainExhausted: false,
        projectionComplete: true,
        reasonCodes: ['frontier-open'],
      },
    ],
  ] as const)('rejects negative proof with %s', (_label, proofClosure) => {
    const result = evaluateAssertions(oneLeg('control', step('main', [], { proofClosure })), {
      mustExclude: [{ kind: 'symbol', name: 'removed' }],
    });

    expect(result.passed).toBe(false);
    expect(result.scopes[0]?.outcomes[0]?.passed).toBe(false);
  });

  it('uses identical scoring logic for both arms', () => {
    const steps = [
      step('main', [
        { kind: 'package', name: 'core' },
        { kind: 'text', label: 'package-manager', value: 'pnpm' },
      ]),
    ];
    const opensip = evaluateAssertions(oneLeg('opensip', ...steps), ordinaryAssertions);
    const control = evaluateAssertions(oneLeg('control', ...steps), ordinaryAssertions);

    expect({ ...opensip, arm: undefined }).toEqual({
      ...control,
      arm: undefined,
    });
  });

  it('does not accept facts attached to a failed invocation', () => {
    const result = evaluateAssertions(
      oneLeg(
        'opensip',
        step('main', [{ kind: 'package', name: 'core' }], {
          failure: {
            code: 'invalid-mcp-json',
            kind: 'protocol',
            message: 'invalid response',
          },
        }),
      ),
      { mustInclude: [{ kind: 'package', name: 'core' }] },
    );

    expect(result.passed).toBe(false);
  });

  it('counts only complete empty responses as incorrect none', () => {
    const completeNone = step('main', [], {
      step: resolvedStep('complete', true),
    });
    const incompleteNone = step('main', [], {
      completeness: 'incomplete',
      step: resolvedStep('incomplete', true),
      truncated: true,
    });
    const failed = step('main', [], {
      failure: { code: 'mcp-request-timeout', kind: 'infrastructure', message: 'timeout' },
      step: resolvedStep('failed', true),
    });
    const result = evaluateAssertions(oneLeg('control', completeNone, incompleteNone, failed), {});

    expect(result).toMatchObject({
      incorrectNone: 1,
      passed: false,
      scopes: [],
    });
  });

  it('accepts a fulfilled strategy-owned non-empty contract', () => {
    const result = evaluateAssertions(
      oneLeg(
        'control',
        step('main', [{ kind: 'text', label: 'answer', value: 'found' }], {
          step: resolvedStep('lookup', true),
        }),
      ),
      {},
    );

    expect(result).toMatchObject({ incorrectNone: 0, passed: true });
  });

  it('fails an incomplete or failed non-empty contract without misclassifying it as false none', () => {
    for (const candidate of [
      step('main', [], {
        completeness: 'incomplete',
        step: resolvedStep('incomplete-only', true),
        truncated: true,
      }),
      step('main', [], {
        failure: { code: 'mcp-request-timeout', kind: 'infrastructure', message: 'timeout' },
        step: resolvedStep('failed-only', true),
      }),
    ]) {
      expect(evaluateAssertions(oneLeg('control', candidate), {})).toMatchObject({
        incorrectNone: 0,
        passed: false,
      });
    }
  });
});

const stalenessAssertions: AnswerAssertions = {
  scoped: [
    { leg: 'pre-edit', mustInclude: [{ kind: 'symbol', name: 'removed' }] },
    { leg: 'post-edit', mustExclude: [{ kind: 'symbol', name: 'removed' }] },
    { leg: 'recovery', mustExclude: [{ kind: 'symbol', name: 'removed' }] },
  ],
  staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
};

describe('staleness evaluation', () => {
  it('isolates legs and accepts fresh post-edit truth', () => {
    const result = evaluateAssertions(
      run('opensip', [
        {
          leg: 'pre-edit',
          steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
        },
        {
          leg: 'post-edit',
          steps: [
            step('post-edit', [], {
              catalogIdentity: 'g1:new',
              freshness: { fresh: true, verification: 'complete' },
            }),
          ],
        },
        { leg: 'recovery', steps: [step('recovery', [])] },
      ]),
      stalenessAssertions,
    );

    expect(result).toMatchObject({
      passed: true,
      staleness: {
        postEditPassed: true,
        recoveryPassed: true,
        verdict: 'fresh',
      },
    });
  });

  it('detects stale evidence served with a complete fresh claim', () => {
    const result = evaluateAssertions(
      run('opensip', [
        {
          leg: 'pre-edit',
          steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
        },
        {
          leg: 'post-edit',
          steps: [
            step('post-edit', [{ kind: 'symbol', name: 'removed' }], {
              catalogIdentity: 'g1:old',
              coverage: { complete: true, truncated: false },
              freshness: { fresh: true, verification: 'complete' },
            }),
          ],
        },
        { leg: 'recovery', steps: [step('recovery', [])] },
      ]),
      stalenessAssertions,
    );

    expect(result.staleness).toEqual({
      postEditPassed: false,
      recoveryPassed: true,
      verdict: 'stale-served-as-fresh',
    });
  });

  it('keeps unattempted or failed recovery out of primary correctness', () => {
    const preEdit: ArmLegRecord = {
      leg: 'pre-edit',
      steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
    };
    const postEdit: ArmLegRecord = {
      leg: 'post-edit',
      steps: [step('post-edit', [])],
    };
    const withoutRecovery = evaluateAssertions(
      run('opensip', [preEdit, postEdit]),
      stalenessAssertions,
    );
    const failedRecovery = evaluateAssertions(
      run('opensip', [
        preEdit,
        postEdit,
        {
          leg: 'recovery',
          steps: [step('recovery', [{ kind: 'symbol', name: 'removed' }])],
        },
      ]),
      stalenessAssertions,
    );

    expect(withoutRecovery).toMatchObject({
      passed: true,
      staleness: { recoveryPassed: undefined, verdict: 'fresh' },
    });
    expect(withoutRecovery.scopes.map(({ leg }) => leg)).not.toContain('recovery');
    expect(failedRecovery).toMatchObject({
      passed: true,
      staleness: { recoveryPassed: false, verdict: 'fresh' },
    });
  });

  it('reports failed required recovery checkpoints even when later facts verify truth', () => {
    const result = evaluateAssertions(
      run('opensip', [
        {
          leg: 'pre-edit',
          steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
        },
        { leg: 'post-edit', steps: [step('post-edit', [])] },
        {
          leg: 'recovery',
          steps: [
            step('recovery', [], {
              failure: {
                code: 'mcp-tool-error',
                kind: 'tool',
                message: 'refresh failed',
              },
              step: resolvedStep('refresh', true),
            }),
            step('recovery', []),
          ],
        },
      ]),
      stalenessAssertions,
    );

    expect(result).toMatchObject({
      passed: true,
      staleness: {
        postEditPassed: true,
        recoveryPassed: false,
        verdict: 'fresh',
      },
    });
  });

  it('distinguishes honest degradation from a false freshness claim', () => {
    const degraded = step('post-edit', [{ kind: 'symbol', name: 'removed' }], {
      completeness: 'incomplete',
      coverage: {
        complete: false,
        hardCapReasons: ['inventory-cap'],
        truncated: true,
      },
      freshness: {
        fresh: false,
        reasonCode: 'catalog-stale',
        verification: 'partial',
      },
    });
    const result = evaluateAssertions(
      run('opensip', [
        {
          leg: 'pre-edit',
          steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
        },
        { leg: 'post-edit', steps: [degraded] },
        { leg: 'recovery', steps: [] },
      ]),
      stalenessAssertions,
    );

    expect(result.staleness).toEqual({
      postEditPassed: false,
      recoveryPassed: undefined,
      verdict: 'honestly-degraded',
    });
  });

  it('keeps matching positive facts degraded until freshness is completely verified', () => {
    const degradedMetadata = {
      freshness: {
        fresh: false,
        reasonCode: 'source-changed',
        verification: 'partial' as const,
      },
    };
    const result = evaluateAssertions(
      run('opensip', [
        {
          leg: 'post-edit',
          steps: [step('post-edit', [{ kind: 'file', path: 'new-caller.ts' }], degradedMetadata)],
        },
        {
          leg: 'recovery',
          steps: [step('recovery', [{ kind: 'file', path: 'new-caller.ts' }], degradedMetadata)],
        },
      ]),
      {
        scoped: [
          {
            leg: 'post-edit',
            mustInclude: [{ kind: 'file', path: 'new-caller.ts' }],
          },
          {
            leg: 'recovery',
            mustInclude: [{ kind: 'file', path: 'new-caller.ts' }],
          },
        ],
        staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
      },
    );

    expect(result.staleness).toEqual({
      postEditPassed: true,
      recoveryPassed: false,
      verdict: 'honestly-degraded',
    });
  });

  it('is inconclusive when no scoped post-edit truth was declared', () => {
    const result = evaluateAssertions(
      run('opensip', [{ leg: 'post-edit', steps: [step('post-edit', [])] }]),
      { staleness: { postEditLeg: 'post-edit' } },
    );

    expect(result.staleness).toEqual({
      postEditPassed: false,
      recoveryPassed: undefined,
      verdict: 'inconclusive',
    });
  });

  it('is inconclusive when the post-edit lookup only fails', () => {
    const result = evaluateAssertions(
      run('control', [
        {
          leg: 'pre-edit',
          steps: [step('pre-edit', [{ kind: 'symbol', name: 'removed' }])],
        },
        {
          leg: 'post-edit',
          steps: [
            step('post-edit', [], {
              failure: {
                code: 'native-tool-failure',
                kind: 'infrastructure',
                message: 'read failed',
              },
            }),
          ],
        },
      ]),
      { ...stalenessAssertions, staleness: { postEditLeg: 'post-edit' } },
    );

    expect(result.staleness).toEqual({
      postEditPassed: false,
      recoveryPassed: undefined,
      verdict: 'inconclusive',
    });
  });
});
