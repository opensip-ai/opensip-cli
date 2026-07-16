import { describe, expect, it, vi } from 'vitest';

import {
  baselineComparisonReplay,
  missingBaselineReplay,
  recommendedNext,
  runSummaryFromReplay,
} from '../session-reply-builders.js';

import type { SignalEnvelope, StoredSession } from '@opensip-cli/contracts';
import type { BaselineRepo } from '@opensip-cli/datastore';

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    tool: 'fit',
    startedAt: '2026-07-10T00:00:00.000Z',
    completedAt: '2026-07-10T00:00:01.000Z',
    cwd: '/proj',
    durationMs: 12,
    score: 100,
    passed: true,
    ...over,
  };
}

function envelope(over: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    verdict: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 } },
    signals: [{ ruleId: 'r1', message: 'm', severity: 'error', fingerprint: 'fp-1' }],
    ...over,
  } as SignalEnvelope;
}

describe('session-reply-builders', () => {
  it('includes optional provenance fields on run summaries when present', () => {
    const withVersions = runSummaryFromReplay(
      session({ cliVersion: '0.5.3', engineVersion: 'graph@1' }),
      envelope(),
    );
    expect(withVersions.cliVersion).toBe('0.5.3');
    expect(withVersions.engineVersion).toBe('graph@1');
    expect(withVersions.showCommand).toContain('sess-1');

    const bare = runSummaryFromReplay(session(), envelope());
    expect(bare.cliVersion).toBeUndefined();
    expect(bare.engineVersion).toBeUndefined();
  });

  it('builds recommended next commands and missing-baseline replies', () => {
    expect(recommendedNext(session({ tool: 'graph' }))).toMatchObject({
      rerunCommand: 'opensip graph',
      showRawEnvelopeCommand: expect.stringContaining('sess-1'),
    });
    const missing = missingBaselineReplay(
      'fit',
      session(),
      envelope({
        signals: [
          { ruleId: 'r', message: 'm', severity: 'error' } as never,
          { ruleId: 'r2', message: 'm2', severity: 'error', fingerprint: 'fp' } as never,
        ],
      }),
    );
    expect(missing.data.baseline.available).toBe(false);
    expect(missing.data.delta.missingFingerprint).toBe(1);
    expect(missing.data.degraded?.[0]?.code).toBe('missing-baseline');
    expect(missing.recommendedNext?.saveBaselineCommand).toContain('--gate-save');
  });

  it('projects baseline comparison with optional capturedAt, identity, and resolved findings', () => {
    const repo = {
      load: vi.fn(() => [{ fingerprint: 'fp-1' }]),
      capturedAt: vi.fn(() => Date.parse('2026-07-01T00:00:00.000Z')),
      loadMeta: vi.fn(() => ({ strategy: 'message-hash' })),
    } as unknown as BaselineRepo;

    const full = baselineComparisonReplay(
      repo,
      { tool: 'fit', limit: 5, includeResolved: true },
      session(),
      envelope(),
    );
    expect(full.data.baseline.available).toBe(true);
    expect(full.data.baseline.capturedAt).toBeDefined();
    expect(full.data.baseline.identity).toEqual({ strategy: 'message-hash' });

    const sparseRepo = {
      load: vi.fn(() => []),
      capturedAt: vi.fn(() => undefined),
      loadMeta: vi.fn(() => undefined),
    } as unknown as BaselineRepo;
    const sparse = baselineComparisonReplay(
      sparseRepo,
      { tool: 'fit' },
      session(),
      envelope({ signals: [] }),
    );
    expect(sparse.data.baseline.available).toBe(true);
    expect(sparse.data.baseline.capturedAt).toBeUndefined();
    expect(sparse.data.baseline.identity).toBeUndefined();
  });
});
