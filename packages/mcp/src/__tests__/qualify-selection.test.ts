/**
 * @fileoverview Saturated-boundary regression for the test-selection trust
 * downgrade (plan 09 Task 1.6). The old gate compared merged reason-code
 * COUNT to the existing count after the 32-reason cap, so at exactly the
 * saturated boundary a new-but-equal-count reason set skipped the downgrade.
 * The gate is now subset membership, decided before the cap.
 */

import { describe, expect, it } from 'vitest';

import { qualifySelection } from '../sqlite-graph-read-port.js';

import type { TestSelectionSnapshot } from '@opensip-cli/contracts';

function snapshotWithReasons(reasonCodes: readonly string[]): TestSelectionSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'sel:fixture',
    files: [],
    tests: [{ path: 'src/a.test.ts', observed: true }],
    commands: [],
    uncoveredFiles: [],
    trust: { status: 'partial', reasonCodes: [...reasonCodes] },
    graphIdentity: 'g1:fixture',
    inventoryIdentity: 'inv:fixture',
  } as unknown as TestSelectionSnapshot;
}

describe('qualifySelection (trust downgrade gate)', () => {
  it('returns the original snapshot when incoming reasons are a subset', () => {
    const snapshot = snapshotWithReasons(['alpha', 'beta']);
    expect(qualifySelection(snapshot, ['alpha'])).toBe(snapshot);
    expect(qualifySelection(snapshot, [])).toBe(snapshot);
  });

  it('downgrades on a new reason even when the merged count is unchanged (32-cap boundary)', () => {
    // 32 existing reasons — the cap. A NEW reason that sorts before the last
    // existing one displaces it, leaving the merged count at exactly 32:
    // the old length-equality gate returned the original snapshot here.
    const existing = Array.from({ length: 32 }, (_, i) =>
      `reason-${String(i).padStart(2, '0')}`,
    );
    const snapshot = snapshotWithReasons(existing);
    const qualified = qualifySelection(snapshot, ['aaa-new-reason']);
    expect(qualified).not.toBe(snapshot);
    expect(qualified.trust.reasonCodes).toHaveLength(32);
    expect(qualified.trust.reasonCodes).toContain('aaa-new-reason');
    expect(qualified.snapshotId).not.toBe(snapshot.snapshotId);
  });

  it('merges, sorts, and caps reason codes on a genuine downgrade', () => {
    const snapshot = snapshotWithReasons(['beta']);
    const qualified = qualifySelection(snapshot, ['alpha']);
    expect(qualified.trust.reasonCodes).toEqual(['alpha', 'beta']);
    expect(qualified.trust.status).toBe('partial');
  });
});
