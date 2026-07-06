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
    id: 'ses-ver-1',
    tool: 'fit',
    startedAt: '2026-07-06T10:00:00.000Z',
    completedAt: '2026-07-06T10:00:01.000Z',
    cwd: '/proj',
    score: 100,
    passed: true,
    durationMs: 1000,
    ...overrides,
  };
}

describe('SessionRepo cli/engine version provenance', () => {
  it('round-trips cliVersion and engineVersion', () => {
    const repo = new SessionRepo(datastore);
    repo.save(session({ cliVersion: '0.4.0', engineVersion: '0.4.0' }));
    const row = repo.get('ses-ver-1');
    expect(row?.cliVersion).toBe('0.4.0');
    expect(row?.engineVersion).toBe('0.4.0');
  });

  it('round-trips cliVersion when the tool has no engine version', () => {
    const repo = new SessionRepo(datastore);
    repo.save(session({ cliVersion: '0.4.0', engineVersion: undefined }));
    const row = repo.get('ses-ver-1');
    expect(row?.cliVersion).toBe('0.4.0');
    expect(row?.engineVersion).toBeUndefined();
  });

  it('omits both on read for legacy rows without stored version columns', () => {
    const repo = new SessionRepo(datastore);
    repo.save(session({ cliVersion: undefined, engineVersion: undefined }));
    const row = repo.get('ses-ver-1');
    expect(row?.cliVersion).toBeUndefined();
    expect(row?.engineVersion).toBeUndefined();
  });
});
