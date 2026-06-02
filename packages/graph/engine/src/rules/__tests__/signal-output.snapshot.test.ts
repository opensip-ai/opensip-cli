/**
 * @fileoverview Signal-output snapshot — locks each rule's full emitted Signal
 * shape (ruleId, severity, category, message, filePath, line, column, metadata)
 * over the shared fixture (Plan B, Phase 5 Task 5.2). Catches message /
 * metadata / severity drift the fingerprint multiset (location-only) cannot.
 *
 * The non-deterministic Signal fields (`id`, `createdAt`) are stripped before
 * snapshotting so the snapshot is stable run-to-run.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { alwaysThrowsBranchRule } from '../always-throws-branch.js';
import { duplicatedFunctionBodyRule } from '../duplicated-function-body.js';
import { noSideEffectPathRule } from '../no-side-effect-path.js';
import { orphanSubtreeRule } from '../orphan-subtree.js';
import { testOnlyReachableRule } from '../test-only-reachable.js';

import { buildAllRulesFixture } from './__fixtures__/catalog.fixture.js';

import type { GraphConfig, Rule } from '../../types.js';
import type { Signal } from '@opensip-tools/core';

const EMPTY_CONFIG: GraphConfig = {};

const RULES: readonly Rule[] = [
  orphanSubtreeRule,
  duplicatedFunctionBodyRule,
  noSideEffectPathRule,
  testOnlyReachableRule,
  alwaysThrowsBranchRule,
];

/** Strip run-varying fields so the snapshot is deterministic. */
function stable(s: Signal): Record<string, unknown> {
  return {
    ruleId: s.ruleId,
    source: s.source,
    provider: s.provider,
    severity: s.severity,
    category: s.category,
    message: s.message,
    suggestion: s.suggestion,
    filePath: s.filePath,
    line: s.line,
    column: s.column,
    metadata: s.metadata,
  };
}

describe('rule signal-output snapshot', () => {
  it('the full emitted Signal set matches the snapshot', () => {
    const catalog = buildAllRulesFixture();
    const indexes = buildIndexes(catalog);
    const signals: Signal[] = [];
    for (const rule of RULES) {
      signals.push(...rule.evaluate(catalog, indexes, EMPTY_CONFIG, undefined));
    }
    const sortKey = (s: Signal): string => `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}`;
    const sorted = [...signals].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map(stable);
    expect(sorted).toMatchSnapshot();
  });
});
