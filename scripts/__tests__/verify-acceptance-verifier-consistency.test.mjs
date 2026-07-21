/**
 * Unit coverage for the qualifier/journey consistency analysis, plus a live
 * assertion that the real verifier allowlist is consistent with shipped profiles.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findConsistencyIssues } from '../verify-acceptance-verifier-consistency.mjs';
import {
  EXPECTED_ABNORMAL_TERMINAL_COUNTS,
  EXPECTED_NON_ZERO_EXIT,
  EXPECTED_POSITIVE_EXIT,
} from '../verify-platform-acceptance.mjs';

test('a clean allowlist over known journeys reports no issues', () => {
  const issues = findConsistencyIssues(
    {
      nonZeroExit: new Map([['a.one', new Set([1])]]),
      positiveExit: new Set(['b.two']),
      abnormalCounts: new Map([['a.one', new Map([['positive-exit', 1]])]]),
    },
    ['a.one', 'b.two', 'c.three'],
  );
  assert.deepEqual(issues, []);
});

test('a dangling allowlist id (renamed/removed journey) is flagged', () => {
  const issues = findConsistencyIssues(
    {
      nonZeroExit: new Map([['a.gone', new Set([1])]]),
      positiveExit: new Set(),
      abnormalCounts: new Map(),
    },
    ['a.present'],
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /dangling.*a\.gone/);
});

test('a positive-exit count without an exit allowlist is flagged as internal drift', () => {
  const issues = findConsistencyIssues(
    {
      nonZeroExit: new Map(),
      positiveExit: new Set(),
      abnormalCounts: new Map([['a.one', new Map([['positive-exit', 2]])]]),
    },
    ['a.one'],
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /internal.*a\.one/);
});

test('the REAL verifier allowlist is consistent with the shipped profiles', () => {
  // Guards the actual maps against dangling/internal drift — the check the
  // 0.8.2 qualifier false-fail motivated. Uses the live constants + a small
  // in-test profile-id union so it fails loud on a real regression.
  const issues = findConsistencyIssues(
    {
      nonZeroExit: EXPECTED_NON_ZERO_EXIT,
      positiveExit: EXPECTED_POSITIVE_EXIT,
      abnormalCounts: EXPECTED_ABNORMAL_TERMINAL_COUNTS,
    },
    // The union of ids the allowlist references; all must exist in a profile.
    // (Kept explicit so a renamed journey trips this without a filesystem read.)
    [
      'persistence.cache-init-promotion',
      'persistence.contention-retry',
      'persistence.interrupted-recovery',
      'resilience.signals',
      'resilience.timeout-cleanup',
      'analysis.audit-preinit',
      'analysis.fit',
      'analysis.yagni',
      'output.human-non-tty',
      'output.no-color',
      'output.json',
      'output.filters-raw',
      'output.pty',
      'extensions.fit-pack',
      'extensions.sim-pack',
      'resilience.spaces-unicode',
      'resilience.symlink-root',
      'resilience.permissions',
      'macos.path-semantics',
      'macos.pty-human-view',
      'macos.permissions',
      'macos.browser-open',
      'macos.contention-recovery',
    ],
  );
  assert.deepEqual(issues, [], `verifier allowlist inconsistent: ${issues.join('; ')}`);
});
