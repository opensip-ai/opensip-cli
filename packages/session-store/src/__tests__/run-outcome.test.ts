import { DataStoreFactory } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';

let datastore: ReturnType<typeof DataStoreFactory.open>;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  datastore.close();
});

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'ses-outcome-1',
    tool: 'fit',
    startedAt: '2026-06-23T10:00:00.000Z',
    completedAt: '2026-06-23T10:00:01.000Z',
    cwd: '/proj',
    score: 0,
    passed: false,
    durationMs: 1000,
    ...overrides,
  };
}

describe('SessionRepo runOutcome (ADR-0060)', () => {
  it('round-trips explicit runOutcome values', () => {
    const repo = new SessionRepo(datastore);
    repo.save(session({ runOutcome: 'error', score: 0, passed: false }));
    const row = repo.get('ses-outcome-1');
    expect(row?.runOutcome).toBe('error');
  });

  it('omits runOutcome on read for legacy rows without a stored column value', () => {
    const repo = new SessionRepo(datastore);
    repo.save(session({ passed: true, score: 100, runOutcome: undefined }));
    expect(repo.get('ses-outcome-1')?.runOutcome).toBeUndefined();

    repo.save({
      ...session({ id: 'ses-outcome-2' }),
      passed: false,
      score: 40,
    });
    expect(repo.get('ses-outcome-2')?.runOutcome).toBeUndefined();
  });
});
