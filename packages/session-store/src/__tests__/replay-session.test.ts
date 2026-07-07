import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { createSignal, HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAndReplaySession } from '../replay-session.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_01',
    tool: 'fit',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:00.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 100,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 } },
    ...overrides,
  };
}

function replayEnvelope(tool: string) {
  return {
    fidelity: 'projection' as const,
    envelope: buildSignalEnvelope({
      tool,
      runId: 'r1',
      createdAt: '2026-01-01T00:00:00.000Z',
      units: [{ slug: 'u', passed: true, durationMs: 1 }],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    }),
  };
}

const throwingReplay = () => {
  throw new Error('bad payload');
};

let datastore: DataStore;
let repo: SessionRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new SessionRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('resolveAndReplaySession', () => {
  it('returns structured failures for resolve errors and missing replay', async () => {
    expect(
      await resolveAndReplaySession(datastore, { ref: 'latest', replayFor: () => undefined }),
    ).toEqual({
      ok: false,
      reason: 'ambiguous-latest',
      detail: 'latest requires --tool fit|graph|sim',
    });

    repo.save(makeSession({ id: 'FIT_01' }));
    expect(
      await resolveAndReplaySession(datastore, {
        ref: 'FIT_01',
        replayFor: () => undefined,
      }),
    ).toEqual({
      ok: false,
      reason: 'replay-unavailable',
      detail: 'session replay is not available for fit',
    });
  });

  it('surfaces decode errors from replay without throwing', async () => {
    repo.save(makeSession({ id: 'FIT_01' }));
    const result = await resolveAndReplaySession(datastore, {
      ref: 'FIT_01',
      replayFor: () => throwingReplay,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'decode-error',
      detail: 'bad payload',
    });
  });

  it('replays successfully and applies agent filters when requested', async () => {
    repo.save(makeSession({ id: 'FIT_01' }));
    const replay = replayEnvelope('fit');
    replay.envelope.signals = [
      createSignal({
        source: 'fit',
        severity: 'high',
        ruleId: 'demo',
        message: 'error',
      }),
      createSignal({
        source: 'fit',
        severity: 'low',
        ruleId: 'demo2',
        message: 'warn',
      }),
    ];
    const replayFn = () => replay;

    const result = await resolveAndReplaySession(datastore, {
      ref: 'FIT_01',
      replayFor: () => replayFn,
      filters: ['errors-only'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.originalSignalCount).toBe(2);
      expect(result.replay.envelope.signals).toHaveLength(1);
      expect(result.replay.envelope.signals[0]?.severity).toBe('high');
    }
  });

  it('replays the newest in-scope latest when cwdWithin is set', async () => {
    repo.save(
      makeSession({
        id: 'IN',
        tool: 'fit',
        cwd: '/repo',
        startedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'FOREIGN',
        tool: 'fit',
        cwd: '/other',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:00:00.000Z',
      }),
    );

    // Record which session actually reaches the replay closure. The newer
    // FOREIGN row is filtered out before resolution, so only IN is replayed.
    const replayedIds: string[] = [];
    const recordingReplay = (stored: StoredSession) => {
      replayedIds.push(stored.id);
      return replayEnvelope(stored.tool);
    };

    const result = await resolveAndReplaySession(datastore, {
      ref: 'latest',
      tool: 'fit',
      cwdWithin: '/repo',
      replayFor: () => recordingReplay,
    });

    expect(result.ok).toBe(true);
    expect(replayedIds).toEqual(['IN']);
    if (result.ok) expect(result.session.cwd).toBe('/repo');
  });
});
