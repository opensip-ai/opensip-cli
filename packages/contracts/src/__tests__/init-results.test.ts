import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  CommandResult,
  InitOptions,
  InitResult,
  RuntimeAdoptionResult,
  RuntimeAdoptionStatus,
  RuntimeAuthoredMutationSummary,
} from '../index.js';

const AUTHORED = {
  created: 3,
  replaced: 2,
  deleted: 1,
  preserved: 4,
} as const satisfies RuntimeAuthoredMutationSummary;

const ADOPTION_BY_STATUS = {
  'not-found': {
    status: 'not-found',
    sourcePreserved: false,
    authored: AUTHORED,
    durationMs: 1,
    reasonCode: 'source-absent',
  },
  promoted: {
    status: 'promoted',
    proofStrength: 'generation-bound',
    sourcePreserved: false,
    sourceRetired: true,
    authored: AUTHORED,
    durationMs: 2,
    reasonCode: 'destination-absent',
  },
  'already-project': {
    status: 'already-project',
    sourcePreserved: false,
    authored: AUTHORED,
    durationMs: 3,
    reasonCode: 'source-absent',
  },
  deduplicated: {
    status: 'deduplicated',
    proofStrength: 'generation-bound',
    sourcePreserved: false,
    sourceRetired: true,
    authored: AUTHORED,
    durationMs: 4,
    reasonCode: 'equivalent',
  },
  'kept-project': {
    status: 'kept-project',
    proofStrength: 'path-only',
    sourcePreserved: false,
    sourceRetired: true,
    authored: AUTHORED,
    durationMs: 5,
  },
  conflict: {
    status: 'conflict',
    proofStrength: 'legacy-unverified',
    sourcePreserved: true,
    durationMs: 6,
    reasonCode: 'divergent',
    nextCommand: 'opensip init --runtime-conflict keep-project',
  },
  busy: {
    status: 'busy',
    durationMs: 7,
    reasonCode: 'lease-busy',
    nextCommand: 'opensip init',
  },
  'recovery-required': {
    status: 'recovery-required',
    durationMs: 8,
    reasonCode: 'operation-interrupted',
    nextCommand: 'opensip init',
  },
  'rolled-back': {
    status: 'rolled-back',
    sourcePreserved: true,
    sourceRetired: false,
    authored: AUTHORED,
    durationMs: 9,
    reasonCode: 'operation-failed',
    nextCommand: 'opensip init',
  },
  'cleanup-pending': {
    status: 'cleanup-pending',
    sourcePreserved: false,
    cleanupPending: true,
    authored: AUTHORED,
    durationMs: 10,
    reasonCode: 'cleanup-pending',
    nextCommand: 'opensip init',
  },
} as const satisfies Record<RuntimeAdoptionStatus, RuntimeAdoptionResult>;

function baseInitResult(runtimeAdoption?: RuntimeAdoptionResult): InitResult {
  return {
    type: 'init',
    created: true,
    path: '/project/opensip-cli.config.yml',
    cwd: '/project',
    configFilename: 'opensip-cli.config.yml',
    state: 'pristine',
    languages: ['typescript'],
    ...(runtimeAdoption === undefined ? {} : { runtimeAdoption }),
  };
}

describe('Init result contracts', () => {
  it('admits every runtime-adoption status through one total fixture', () => {
    const statuses = Object.keys(ADOPTION_BY_STATUS);

    expect(statuses).toEqual([
      'not-found',
      'promoted',
      'already-project',
      'deduplicated',
      'kept-project',
      'conflict',
      'busy',
      'recovery-required',
      'rolled-back',
      'cleanup-pending',
    ]);
    for (const result of Object.values(ADOPTION_BY_STATUS)) {
      expect(baseInitResult(result).runtimeAdoption).toBe(result);
    }
    expectTypeOf(baseInitResult(ADOPTION_BY_STATUS.promoted)).toExtend<CommandResult>();
  });

  it('keeps the authored projection fixed and path-neutral', () => {
    expect(Object.keys(AUTHORED)).toEqual(['created', 'replaced', 'deleted', 'preserved']);

    const encoded = JSON.stringify(Object.values(ADOPTION_BY_STATUS));
    expect(encoded).not.toMatch(
      /(?:\/project|runtime-promotion\.json|manifestDigest|ownerToken|payload)/u,
    );
    expect(encoded.length).toBeLessThan(4096);
  });

  it('keeps runtime adoption additive for early and legacy Init results', () => {
    const result = baseInitResult();

    expect(result).not.toHaveProperty('runtimeAdoption');
    expectTypeOf(result).toExtend<CommandResult>();
  });

  it('represents a concurrent authored-state change without implying a mutation', () => {
    const result: InitResult = {
      ...baseInitResult(),
      created: false,
      state: 'partial-config-only',
      authoredStateChangedError: {
        observedState: 'partial-config-only',
        message: 'Retry Init.',
      },
    };

    expect(result.authoredStateChangedError?.observedState).toBe('partial-config-only');
    expectTypeOf(result).toExtend<CommandResult>();
  });

  it('exposes only the closed runtime-conflict policy vocabulary', () => {
    expectTypeOf<InitOptions['runtimeConflict']>().toEqualTypeOf<
      'abort' | 'keep-project' | 'use-cache' | undefined
    >();

    const invalidPolicy = {
      cwd: '/project',
      json: false,
      debug: false,
      // @ts-expect-error -- runtime conflict policies are a closed public enum.
      runtimeConflict: 'merge',
    } satisfies InitOptions;
    expect(invalidPolicy.runtimeConflict).toBe('merge');
  });
});
