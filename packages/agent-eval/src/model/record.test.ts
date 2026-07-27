import { describe, expect, it } from 'vitest';

import { isStepFailureCode, makeStepRecord, STEP_FAILURE_CODES } from './record.js';

import type { StepFreshness } from './record.js';
import type { ResolvedStrategyStep } from './task.js';

const STEP: ResolvedStrategyStep = {
  arguments: {},
  expectedNonEmpty: true,
  extract: () => [],
  id: 'lookup',
  rationale: 'Look up evidence.',
  tool: 'search_symbols',
};

function emptyWithFreshness(freshness: StepFreshness) {
  return makeStepRecord({
    coverage: { complete: true, truncated: false },
    freshness,
    leg: 'main',
    renderedResponse: '{}',
    step: STEP,
    wallMs: 1,
  });
}

describe('makeStepRecord', () => {
  it('recognizes only the closed durable failure vocabulary', () => {
    expect(STEP_FAILURE_CODES.every(isStepFailureCode)).toBe(true);
    expect(isStepFailureCode('future-failure')).toBe(false);
    expect(isStepFailureCode(undefined)).toBe(false);
  });

  it.each([
    { fresh: false, reasonCode: 'source-changed', verification: 'complete' },
    { fresh: false, verification: 'partial' },
    { fresh: false, reasonCode: 'missing', verification: 'missing' },
  ] as const)('records empty $verification freshness as incomplete', (freshness) => {
    expect(emptyWithFreshness(freshness)).toMatchObject({
      completeness: 'incomplete',
      noneOutcome: 'empty-incomplete',
    });
  });

  it('retains complete empty semantics only for completely verified freshness', () => {
    expect(emptyWithFreshness({ fresh: true, verification: 'complete' })).toMatchObject({
      completeness: 'complete',
      noneOutcome: 'empty-complete',
    });
  });

  it('discards contradictory facts from failed invocations at the durable boundary', () => {
    const record = makeStepRecord({
      facts: [{ kind: 'file', path: 'must-not-survive.ts' }],
      failure: { code: 'native-tool-failure', kind: 'tool', message: 'failed' },
      leg: 'main',
      renderedResponse: 'bad',
      step: STEP,
      wallMs: 1,
    });

    expect(record.facts).toEqual([]);
    expect(record.noneOutcome).toBe('failed');
  });
});
