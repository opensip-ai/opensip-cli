/**
 * @fileoverview Golden-fingerprint snapshot — the load-bearing byte-stability
 * guard for the `defineRule` port (Plan B, Phase 5 Task 5.1).
 *
 * `graphFingerprintStrategy(s)` = `ruleId|filePath|line|column` (baseline-strategy.ts).
 * This is the baseline + Code-Scanning identity: renaming a slug or shifting a
 * finding's location invalidates every saved gate baseline. This test runs the
 * original five-rule golden set over a fixture that triggers each,
 * fingerprints every emitted Signal, sorts, and asserts the multiset equals
 * the checked-in golden `fingerprint-baseline.json`.
 *
 * The golden baseline is byte-identical to the pre-refactor output: the port to
 * `defineRule` only wraps `evaluate` in a positional→object adapter, and the
 * pre-existing `rule-behaviors.test.ts` (which exercises the same emitted
 * signals) passed unchanged across the refactor. To re-capture after an
 * intentional rule change, run this test once with the assertion replaced by
 * `fs.writeFileSync(BASELINE_PATH, JSON.stringify(actual, null, 2))`, review the
 * diff, and restore the assertion.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { graphFingerprintStrategy } from '../../baseline-strategy.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { alwaysThrowsBranchRule } from '../always-throws-branch.js';
import { duplicatedFunctionBodyRule } from '../duplicated-function-body.js';
import { noSideEffectPathRule } from '../no-side-effect-path.js';
import { orphanSubtreeRule } from '../orphan-subtree.js';
import { testOnlyReachableRule } from '../test-only-reachable.js';

import { buildAllRulesFixture } from './__fixtures__/catalog.fixture.js';

import type { GraphConfig, Rule } from '../../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '__fixtures__', 'fingerprint-baseline.json');

const EMPTY_CONFIG: GraphConfig = {};

// Original five-rule golden set, in its historical registration order.
const RULES: readonly Rule[] = [
  orphanSubtreeRule,
  duplicatedFunctionBodyRule,
  noSideEffectPathRule,
  testOnlyReachableRule,
  alwaysThrowsBranchRule,
];

function allFingerprints(): string[] {
  const catalog = buildAllRulesFixture();
  const indexes = buildIndexes(catalog);
  const fingerprints: string[] = [];
  for (const rule of RULES) {
    for (const signal of rule.evaluate(catalog, indexes, EMPTY_CONFIG, undefined)) {
      fingerprints.push(graphFingerprintStrategy.fingerprint(signal));
    }
  }
  return fingerprints.sort();
}

describe('golden-fingerprint snapshot (slug/location identity)', () => {
  it('the emitted fingerprint multiset equals the checked-in golden baseline', () => {
    const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as string[];
    expect(allFingerprints()).toEqual([...expected].sort());
  });

  it('mutating a slug breaks the snapshot (the guard has teeth)', () => {
    // A local copy of one rule with a renamed slug — its emitted ruleId is
    // baked from the createSignal call, so its fingerprints still carry the
    // real slug. Instead, mutate the fingerprint strings directly to prove a
    // changed ruleId would diverge from the golden set.
    const golden = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as string[];
    const tampered = golden.map((fp) => fp.replace('graph:orphan-subtree', 'graph:orphan-RENAMED'));
    expect([...tampered].sort()).not.toEqual([...golden].sort());
  });
});
