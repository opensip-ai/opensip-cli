import { describe, expect, it } from 'vitest';

import {
  freshnessFromVerification,
  missingFreshness,
  unavailableGraphStatus,
} from '../freshness.js';

describe('freshness mapping', () => {
  it('missingFreshness is not complete', () => {
    const f = missingFreshness();
    expect(f.fresh).toBe(false);
    expect(f.verification).toBe('missing');
    expect(f.reasonCode).toBe('missing');
    expect(f.verifiedAt).toBeTruthy();
  });

  it('partial verification never claims fresh', () => {
    const f = freshnessFromVerification(
      {
        fresh: true,
        verifiedAt: '2026-01-01T00:00:00.000Z',
        verification: 'partial',
        reasonCode: 'verification-unavailable',
        reason: 'no provenance',
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(f.fresh).toBe(false);
    expect(f.verification).toBe('partial');
  });

  it('complete fresh verification passes through', () => {
    const f = freshnessFromVerification(
      {
        fresh: true,
        verifiedAt: '2026-01-01T00:00:00.000Z',
        verification: 'complete',
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(f.fresh).toBe(true);
    expect(f.builtAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('omits optional fields when verification has no builtAt/reason/changes', () => {
    const f = freshnessFromVerification({
      fresh: false,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      verification: 'complete',
    });
    expect(f.fresh).toBe(false);
    expect(f.builtAt).toBeUndefined();
    expect(f.reasonCode).toBeUndefined();
    expect(f.reason).toBeUndefined();
    expect(f.changes).toBeUndefined();

    const withChanges = freshnessFromVerification({
      fresh: false,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      verification: 'partial',
      reasonCode: 'files-changed',
      reason: 'file churn',
      changes: { added: 1, modified: 0, deleted: 0, sample: [] },
    });
    expect(withChanges.changes).toEqual({ added: 1, modified: 0, deleted: 0, sample: [] });
    expect(withChanges.reasonCode).toBe('files-changed');
  });

  it('unavailableGraphStatus is the review_change degradation shape', () => {
    const f = unavailableGraphStatus();
    expect(f).toMatchObject({
      fresh: false,
      verification: 'partial',
      reasonCode: 'verification-unavailable',
      reason: 'Graph status unavailable',
    });
  });
});
