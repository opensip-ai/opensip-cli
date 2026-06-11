/**
 * verdict-policy — the host-owned findings gate (ADR-0035). Pins the truth table
 * for `policyPasses` and the reserved-key resolution + per-key `{1,0}` fallback
 * of `resolveVerdictPolicy`, so a future edit can't silently drift the gate.
 */

import { describe, expect, it } from 'vitest';

import { makeTestScope } from '../../test-utils/with-scope.js';
import { runWithScopeSync } from '../run-scope.js';
import {
  HOST_VERDICT_POLICY_FALLBACK,
  policyPasses,
  resolveVerdictPolicy,
  type VerdictPolicy,
} from '../verdict-policy.js';

import type { ResolvedToolConfig } from '../scope-types.js';

describe('policyPasses', () => {
  // [errors, warnings, failOnErrors, failOnWarnings, expectedPasses]
  const cases: readonly (readonly [number, number, number, number, boolean])[] = [
    // {1,0} fallback: fail on any error, warnings informational.
    [0, 0, 1, 0, true],
    [1, 0, 1, 0, false],
    [0, 5, 1, 0, true], // warning-only run PASSES with failOnWarnings:0
    // failOnErrors:0 disables the error gate.
    [3, 0, 0, 0, true],
    // failOnWarnings:k boundary (k active when > 0).
    [0, 1, 1, 2, true], // 1 < 2 → pass
    [0, 2, 1, 2, false], // 2 >= 2 → fail
    [0, 1, 1, 1, false], // 1 >= 1 → fail
    // error gate boundary.
    [2, 0, 3, 0, true], // 2 < 3 → pass
    [3, 0, 3, 0, false], // 3 >= 3 → fail
  ];

  for (const [errors, warnings, failOnErrors, failOnWarnings, expected] of cases) {
    it(`(${errors}e,${warnings}w) vs {${failOnErrors},${failOnWarnings}} → ${expected ? 'PASS' : 'FAIL'}`, () => {
      const policy: VerdictPolicy = { failOnErrors, failOnWarnings };
      expect(policyPasses({ errors, warnings }, policy)).toBe(expected);
    });
  }
});

/** Resolve a tool's policy inside a scope carrying the given resolved toolConfig. */
function resolveWith(toolConfig: ResolvedToolConfig | undefined, ns = 'graph'): VerdictPolicy {
  const scope = makeTestScope();
  if (toolConfig !== undefined) Object.assign(scope, { toolConfig });
  return runWithScopeSync(scope, () => resolveVerdictPolicy(ns));
}

describe('resolveVerdictPolicy', () => {
  it('returns the host fallback {1,0} when the namespace declares neither key', () => {
    expect(resolveWith({ graph: {} })).toEqual(HOST_VERDICT_POLICY_FALLBACK);
  });

  it('returns the host fallback {1,0} when there is no toolConfig at all', () => {
    expect(resolveWith(undefined)).toEqual(HOST_VERDICT_POLICY_FALLBACK);
  });

  it('reads both reserved keys when declared', () => {
    expect(resolveWith({ fitness: { failOnErrors: 0, failOnWarnings: 2 } }, 'fitness')).toEqual({
      failOnErrors: 0,
      failOnWarnings: 2,
    });
  });

  it('falls back per-key: a tool may declare one key and inherit the other', () => {
    expect(resolveWith({ graph: { failOnWarnings: 3 } })).toEqual({
      failOnErrors: 1, // inherited
      failOnWarnings: 3, // declared
    });
  });

  it('ignores non-integer / negative values, falling back to the host default', () => {
    expect(resolveWith({ graph: { failOnErrors: -1, failOnWarnings: 1.5 } })).toEqual(
      HOST_VERDICT_POLICY_FALLBACK,
    );
  });
});
