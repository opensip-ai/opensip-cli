import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { showHistory } from '../commands/history.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

let tmp: string;
let ds: DataStore;

function makeSession(
  id: string,
  score: number,
  ts: number = Date.now(),
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/x',
    startedAt: new Date(ts).toISOString(),
    completedAt: new Date(ts).toISOString(),
    score,
    passed: score >= 90,
    durationMs: 100,
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-hist-'));
  ds = DataStoreFactory.open({
    backend: 'sqlite',
    path: join(tmp, 'd.sqlite'),
  });
});

afterEach(() => {
  ds.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('showHistory', () => {
  it('returns an empty session list for a fresh datastore', () => {
    const result = showHistory(ds);
    expect(result.type).toBe('history');
    expect(result.sessions).toEqual([]);
  });

  it('returns every stored session', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('a', 95));
    repo.save(makeSession('b', 70));
    const result = showHistory(ds);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('filters and limits stored sessions', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('fit-1', 95, Date.now(), { tool: 'fit' }));
    repo.save(makeSession('graph-1', 95, Date.now() + 1, { tool: 'graph' }));
    repo.save(makeSession('fit-2', 95, Date.now() + 2, { tool: 'fit' }));
    const result = showHistory(ds, { tool: 'fit', limit: 1 });
    expect(result.sessions.map((s) => s.id)).toEqual(['fit-2']);
  });

  it('adds summary and showCommand fields for json consumers', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_01', 95));
    const result = showHistory(ds);
    expect(result.sessions[0]?.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      warnings: 0,
    });
    expect(result.sessions[0]?.showCommand).toBe('opensip sessions show FIT_01 --json');
  });

  it('keeps suite grouping keys in the JSON projection', () => {
    const repo = new SessionRepo(ds);
    repo.save(
      makeSession('FIT_SUITE_01', 95, Date.now(), {
        suiteRunId: 'suite-run-1',
        suiteName: 'security',
      }),
    );

    const [session] = showHistory(ds).sessions;
    expect(session?.suiteRunId).toBe('suite-run-1');
    expect(session?.suiteName).toBe('security');
  });

  it('adds suiteGroups when multiple steps share a suiteRunId', () => {
    const repo = new SessionRepo(ds);
    repo.save(
      makeSession('FIT_SUITE_01', 95, Date.now(), {
        suiteRunId: 'suite-run-1',
        suiteName: 'security',
      }),
    );
    repo.save(
      makeSession('GRAPH_SUITE_01', 90, Date.now() + 1, {
        tool: 'graph',
        suiteRunId: 'suite-run-1',
        suiteName: 'security',
      }),
    );
    repo.save(makeSession('FIT_SOLO_01', 95, Date.now() + 2));

    const result = showHistory(ds);
    expect(result.suiteGroups).toEqual([
      {
        suiteRunId: 'suite-run-1',
        suiteName: 'security',
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: 'FIT_SUITE_01' }),
          expect.objectContaining({ id: 'GRAPH_SUITE_01' }),
        ]),
      },
    ]);
    expect(result.suiteGroups?.[0]?.sessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Summary projection guards. `sessionSummary` only surfaces a summary when the
// opaque payload actually carries a well-typed `summary` object; every other
// shape (non-object payload, missing/non-object summary, a non-numeric field)
// degrades to no summary. The base tests only use a valid summary, so those
// defensive branches went uncovered.
// ---------------------------------------------------------------------------

describe('showHistory — summary projection guards', () => {
  it('omits the summary when the payload is not an object', () => {
    new SessionRepo(ds).save(makeSession('np', 90, Date.now(), { payload: 'not-an-object' }));
    expect(showHistory(ds).sessions[0]?.summary).toBeUndefined();
  });

  it('omits the summary when summary is missing or itself not an object', () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('ns', 90, Date.now(), { payload: { checks: [] } }));
    repo.save(makeSession('bs', 90, Date.now() + 1, { payload: { summary: 'nope' } }));
    expect(showHistory(ds).sessions.every((s) => s.summary === undefined)).toBe(true);
  });

  it('omits the summary when any field is the wrong type', () => {
    new SessionRepo(ds).save(
      makeSession('wt', 90, Date.now(), {
        payload: {
          summary: {
            total: 'NaN',
            passed: 1,
            failed: 0,
            errors: 0,
            warnings: 0,
          },
        },
      }),
    );
    expect(showHistory(ds).sessions[0]?.summary).toBeUndefined();
  });

  it('summary-only mode drops the heavy payload but keeps the lightweight summary', () => {
    new SessionRepo(ds).save(makeSession('so', 90));
    const lean = showHistory(ds, { summaryOnly: true });
    expect(lean.sessions[0]?.payload).toBeUndefined();
    expect(lean.sessions[0]?.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      warnings: 0,
    });
  });
});
