import { describe, expect, it } from 'vitest';

import {
  MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES,
  MAX_BOUNDED_PATTERN_BYTES,
  preflightGlobalFilterCandidates,
  preflightInputs,
  snapshotMembershipOptions,
  snapshotResolutionOptions,
} from '../bounded-resolve-inputs.js';

import type { TargetView } from '@opensip-cli/core';

function target(
  include: readonly string[] = ['**/*.ts'],
  exclude: readonly string[] = [],
  name = 'source',
): TargetView {
  return {
    config: { name, description: name, include, exclude },
  };
}

describe('snapshotResolutionOptions', () => {
  it('freezes a valid maxResults snapshot and drops an undefined signal', () => {
    const snapshot = snapshotResolutionOptions({ maxResults: 3 });
    expect(snapshot).toEqual({ maxResults: 3 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('preserves an abort signal when supplied', () => {
    const signal = new AbortController().signal;
    expect(snapshotResolutionOptions({ maxResults: 1, signal })).toEqual({
      maxResults: 1,
      signal,
    });
  });
});

describe('snapshotMembershipOptions', () => {
  it('rejects non-positive or oversized maxTargetsPerFile', () => {
    expect(() => snapshotMembershipOptions({ maxResults: 1, maxTargetsPerFile: 0 })).toThrow(
      /maxTargetsPerFile/,
    );
    expect(() => snapshotMembershipOptions({ maxResults: 1, maxTargetsPerFile: 1.5 })).toThrow(
      /maxTargetsPerFile/,
    );
  });
});

describe('preflightInputs', () => {
  it('rejects a non-array targets value without invoking iterators', () => {
    expect(() => preflightInputs('not-array' as unknown as TargetView[], [])).toThrow(
      /must be an array/,
    );
  });

  it('rejects a non-array global exclude collection', () => {
    expect(() => preflightInputs([target()], 'nope' as unknown as string[])).toThrow(
      /must be an array/,
    );
  });

  it('rejects a non-object target entry', () => {
    expect(() => preflightInputs([null as unknown as TargetView], [])).toThrow(
      /must contain config objects/,
    );
    expect(() => preflightInputs([42 as unknown as TargetView], [])).toThrow(
      /must contain config objects/,
    );
  });

  it('rejects a target whose config is missing or not an object', () => {
    expect(() => preflightInputs([{ config: null } as unknown as TargetView], [])).toThrow(
      /must contain config objects/,
    );
    expect(() => preflightInputs([{ config: 'nope' } as unknown as TargetView], [])).toThrow(
      /must contain config objects/,
    );
    expect(() => preflightInputs([{} as unknown as TargetView], [])).toThrow(
      /must contain config objects/,
    );
  });

  it('rejects non-string glob patterns', () => {
    expect(() => preflightInputs([target([1 as unknown as string])], [])).toThrow(
      /must be strings/,
    );
  });

  it('rejects empty, oversized, or control-bearing target names', () => {
    expect(() => preflightInputs([target(['**/*.ts'], [], '')], [])).toThrow(
      /Target names must be bounded/,
    );
    expect(() =>
      preflightInputs([target(['**/*.ts'], [], 'x'.repeat(MAX_BOUNDED_PATTERN_BYTES + 1))], []),
    ).toThrow(/Target names must be bounded/);
    expect(() => preflightInputs([target(['**/*.ts'], [], 'bad\nname')], [])).toThrow(
      /Target names must be bounded/,
    );
  });

  it('snapshots well-formed inputs into frozen views', () => {
    const snapshot = preflightInputs(
      [target(['src/**/*.ts'], ['**/*.test.ts'], 'alpha')],
      ['**/generated/**'],
    );
    expect(snapshot.globalExcludes).toEqual(['**/generated/**']);
    expect(snapshot.targets).toEqual([
      {
        config: {
          name: 'alpha',
          description: '',
          include: ['src/**/*.ts'],
          exclude: ['**/*.test.ts'],
        },
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.targets[0]?.config)).toBe(true);
  });
});

describe('preflightGlobalFilterCandidates', () => {
  it('rejects non-string candidate paths', () => {
    expect(() => preflightGlobalFilterCandidates([1 as unknown as string])).toThrow(
      /must be strings/,
    );
  });

  it('rejects empty, oversized, or control-bearing candidate paths', () => {
    expect(() => preflightGlobalFilterCandidates([''])).toThrow(/outside its hard bounds/);
    expect(() =>
      preflightGlobalFilterCandidates(['x'.repeat(MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES + 1)]),
    ).toThrow(/outside its hard bounds/);
    expect(() => preflightGlobalFilterCandidates(['a\u0000b'])).toThrow(/outside its hard bounds/);
  });

  it('returns a frozen copy of valid candidates', () => {
    const out = preflightGlobalFilterCandidates(['src/a.ts', 'src/b.ts']);
    expect(out).toEqual(['src/a.ts', 'src/b.ts']);
    expect(Object.isFrozen(out)).toBe(true);
  });
});
