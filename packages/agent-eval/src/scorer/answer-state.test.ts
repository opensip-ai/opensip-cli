import { describe, expect, it } from 'vitest';

import { makeStepRecord, type MakeStepRecordInput } from '../model/record.js';

import {
  appendStepRecord,
  canAnswer,
  createAnswerState,
  resetAnswerState,
} from './answer-state.js';

import type { AnswerFact, RunLeg, ScopedAnswerAssertions } from '../model/task.js';

const extractNothing = (): readonly AnswerFact[] => [];

function resolvedStep(expectedNonEmpty = false) {
  return {
    arguments: {},
    expectedNonEmpty,
    extract: extractNothing,
    id: 'discover',
    provesAbsence: [{ kind: 'symbol' as const, name: 'removed' }],
    rationale: 'Discover answer facts.',
    tool: 'search',
  };
}

function step(
  leg: RunLeg,
  facts: readonly AnswerFact[],
  overrides: Partial<MakeStepRecordInput> = {},
) {
  return makeStepRecord({
    completeness: 'complete',
    facts,
    leg,
    proofClosure: { domainExhausted: true, projectionComplete: true, reasonCodes: [] },
    renderedResponse: JSON.stringify(facts),
    step: resolvedStep(),
    wallMs: 3,
    ...overrides,
  });
}

describe('answer state', () => {
  it('appends fact provenance immutably', () => {
    const initial = createAnswerState('main');
    const next = appendStepRecord(initial, step('main', [{ kind: 'package', name: 'a' }]));

    expect(initial.steps).toHaveLength(0);
    expect(next.observations).toEqual([
      {
        fact: { kind: 'package', name: 'a' },
        leg: 'main',
        ordinal: 0,
        stepId: 'discover',
      },
    ]);
  });

  it('resets all observations when the run leg changes', () => {
    const preEdit = appendStepRecord(
      createAnswerState('pre-edit'),
      step('pre-edit', [{ kind: 'symbol', name: 'removed' }]),
    );
    const postEdit = resetAnswerState(preEdit, 'post-edit');

    expect(postEdit).toEqual({ leg: 'post-edit', observations: [], steps: [] });
    expect(
      canAnswer(postEdit, {
        leg: 'post-edit',
        mustExclude: [{ kind: 'symbol', name: 'removed' }],
      }),
    ).toBe(false);
  });

  it('rejects cross-leg contamination', () => {
    expect(() => appendStepRecord(createAnswerState('pre-edit'), step('post-edit', []))).toThrow(
      'Cannot append a post-edit step to pre-edit answer state.',
    );
  });

  it('answers when required facts are present', () => {
    const assertions: ScopedAnswerAssertions = {
      leg: 'main',
      mustInclude: [{ kind: 'symbol-handle', symbolId: 'symbol:run' }],
    };
    const state = appendStepRecord(
      createAnswerState('main'),
      step('main', [{ kind: 'symbol-handle', symbolId: 'symbol:run' }]),
    );

    expect(canAnswer(state, assertions)).toBe(true);
    expect(
      canAnswer(state, {
        ...assertions,
        mustInclude: [{ kind: 'symbol-handle', symbolId: 'symbol:other' }],
      }),
    ).toBe(false);

    const failed = appendStepRecord(
      createAnswerState('main'),
      step('main', [{ kind: 'symbol-handle', symbolId: 'symbol:run' }], {
        failure: {
          code: 'protocol',
          kind: 'protocol',
          message: 'invalid response',
        },
      }),
    );
    expect(canAnswer(failed, assertions)).toBe(false);
  });

  it('honors the strategy step non-empty contract without duplicated assertions', () => {
    const state = appendStepRecord(
      createAnswerState('main'),
      step('main', [], { step: resolvedStep(true) }),
    );

    expect(canAnswer(state, { leg: 'main' })).toBe(false);
  });

  it('requires complete evidence before answering a negative-only question', () => {
    const assertions: ScopedAnswerAssertions = {
      leg: 'main',
      mustExclude: [{ kind: 'symbol', name: 'removed' }],
    };
    const incomplete = appendStepRecord(
      createAnswerState('main'),
      step('main', [], { completeness: 'incomplete', truncated: true }),
    );
    const complete = appendStepRecord(createAnswerState('main'), step('main', []));
    const stale = appendStepRecord(
      createAnswerState('main'),
      step('main', [], {
        freshness: {
          fresh: false,
          reasonCode: 'catalog-stale',
          verification: 'partial',
        },
      }),
    );
    const conflicting = appendStepRecord(
      createAnswerState('main'),
      step('main', [{ kind: 'symbol', name: 'removed' }]),
    );

    expect(canAnswer(incomplete, assertions)).toBe(false);
    expect(canAnswer(complete, assertions)).toBe(true);
    expect(canAnswer(stale, assertions)).toBe(false);
    expect(canAnswer(conflicting, assertions)).toBe(false);
  });

  it('requires the exhaustive step to cover the asserted negative domain', () => {
    const assertions: ScopedAnswerAssertions = {
      leg: 'main',
      mustExclude: [{ kind: 'symbol', name: 'removed' }],
    };
    const unrelated = appendStepRecord(
      createAnswerState('main'),
      step('main', [], {
        step: {
          ...resolvedStep(),
          provesAbsence: [{ kind: 'file', path: 'src/other.ts' }],
        },
      }),
    );
    const paged = appendStepRecord(
      createAnswerState('main'),
      step('main', [], { nextCursor: 'r1:more' }),
    );

    expect(canAnswer(unrelated, assertions)).toBe(false);
    expect(canAnswer(paged, assertions)).toBe(false);
  });

  it('does not early-exit on terminal absence after a truncated discovery step', () => {
    const assertions: ScopedAnswerAssertions = {
      leg: 'main',
      mustExclude: [{ kind: 'symbol', name: 'removed' }],
    };
    const partial = appendStepRecord(
      createAnswerState('main'),
      step('main', [{ kind: 'text', label: 'frontier', value: 'partial' }], {
        completeness: 'incomplete',
        step: { ...resolvedStep(true), provesAbsence: [] },
        truncated: true,
      }),
    );
    const terminal = appendStepRecord(partial, step('main', []));

    expect(canAnswer(terminal, assertions)).toBe(false);
  });

  it('requires at least one step for an assertion-free task', () => {
    const emptyAssertions: ScopedAnswerAssertions = { leg: 'main' };
    expect(canAnswer(createAnswerState('main'), emptyAssertions)).toBe(false);
    expect(
      canAnswer(appendStepRecord(createAnswerState('main'), step('main', [])), emptyAssertions),
    ).toBe(true);
  });
});
