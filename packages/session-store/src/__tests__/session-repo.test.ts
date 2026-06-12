import { DataStoreFactory, type DataStore, type DrizzleDataStore } from '@opensip-cli/datastore';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessions } from '../schema/sessions.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';

// A representative opaque payload. `contracts` never inspects the shape;
// these tests exercise verbatim round-tripping of whatever a tool writes.
function fitnessLikePayload(): unknown {
  return {
    summary: { total: 5, passed: 4, failed: 1, errors: 0, warnings: 1 },
    checks: [
      {
        checkSlug: 'demo-check',
        passed: true,
        violationCount: 1,
        durationMs: 50,
        findings: [
          {
            ruleId: 'demo-check',
            message: 'demo finding',
            severity: 'warning',
            filePath: 'src/a.ts',
            line: 10,
          },
        ],
      },
    ],
  };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'ses-test-1',
    tool: 'fit',
    timestamp: '2026-05-21T12:00:00.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 95,
    passed: true,
    durationMs: 250,
    payload: fitnessLikePayload(),
    ...overrides,
  };
}

let datastore: DrizzleDataStore;
let repo: SessionRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new SessionRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('SessionRepo — save / get', () => {
  it('persists a session with its opaque payload and reads it back unchanged', () => {
    const session = makeSession();
    repo.save(session);
    const fetched = repo.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(session);
  });

  it('returns null when getting a non-existent id', () => {
    expect(repo.get('does-not-exist')).toBeNull();
  });

  it('round-trips a session with no payload (tools may persist none)', () => {
    const session = makeSession({ payload: undefined });
    repo.save(session);
    const fetched = repo.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.payload).toBeUndefined();
  });

  it('treats the payload as fully opaque — any JSON shape round-trips verbatim', () => {
    const payload = {
      kind: 'graph',
      summary: { total: 3 },
      nested: [{ a: 1 }, { b: [true, null] }],
    };
    const session = makeSession({ id: 'opaque', tool: 'graph', payload });
    repo.save(session);
    expect(repo.get('opaque')?.payload).toEqual(payload);
  });
});

describe('SessionRepo — list', () => {
  it('lists sessions newest-first by timestamp', () => {
    repo.save(makeSession({ id: 'a', timestamp: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'b', timestamp: '2026-05-02T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'c', timestamp: '2026-05-03T00:00:00.000Z' }));
    const ordered = repo.list();
    expect(ordered.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('honors limit', () => {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(2026, 0, i + 1).toISOString();
      repo.save(makeSession({ id: `s${String(i)}`, timestamp: ts }));
    }
    expect(repo.list({ limit: 2 })).toHaveLength(2);
  });

  it('honors tool filter', () => {
    repo.save(makeSession({ id: 'fit-1', tool: 'fit' }));
    repo.save(makeSession({ id: 'sim-1', tool: 'sim' }));
    repo.save(makeSession({ id: 'graph-1', tool: 'graph' }));
    const onlyFit = repo.list({ tool: 'fit' });
    expect(onlyFit).toHaveLength(1);
    expect(onlyFit[0]?.id).toBe('fit-1');
  });
});

describe('SessionRepo — purge / clearAll / count', () => {
  it('count() returns the row count', () => {
    expect(repo.count()).toBe(0);
    repo.save(makeSession({ id: 'a' }));
    repo.save(makeSession({ id: 'b' }));
    expect(repo.count()).toBe(2);
  });

  it('purge(date) deletes sessions older than the cutoff', () => {
    repo.save(makeSession({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'recent', timestamp: '2026-05-21T00:00:00.000Z' }));
    const cutoff = new Date('2026-03-01T00:00:00.000Z');
    const removed = repo.purge(cutoff);
    expect(removed).toBe(1);
    expect(repo.get('old')).toBeNull();
    expect(repo.get('recent')).not.toBeNull();
  });

  it('clearAll removes every session', () => {
    repo.save(makeSession({ id: 'a' }));
    repo.save(makeSession({ id: 'b' }));
    expect(repo.clearAll()).toBe(2);
    expect(repo.count()).toBe(0);
  });
});

describe('SessionRepo — payload round-trip', () => {
  it('preserves a nested payload aggregate exactly', () => {
    const payload = { summary: { total: 100, passed: 90, failed: 10, errors: 3, warnings: 7 } };
    const session = makeSession({ payload });
    repo.save(session);
    expect(repo.get(session.id)?.payload).toEqual(payload);
  });
});

describe('SessionRepo — latest', () => {
  it('returns null when no sessions exist', () => {
    expect(repo.latest()).toBeNull();
  });

  it('returns the most recent session by timestamp', () => {
    repo.save(makeSession({ id: 'old', timestamp: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'newer', timestamp: '2026-05-15T00:00:00.000Z' }));
    expect(repo.latest()?.id).toBe('newer');
  });

  it('returns the most recent session scoped to a tool', () => {
    repo.save(makeSession({ id: 'fit-old', tool: 'fit', timestamp: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'fit-new', tool: 'fit', timestamp: '2026-05-02T00:00:00.000Z' }));
    repo.save(
      makeSession({ id: 'graph-newer', tool: 'graph', timestamp: '2026-05-03T00:00:00.000Z' }),
    );
    expect(repo.latest({ tool: 'fit' })?.id).toBe('fit-new');
    expect(repo.latest()?.id).toBe('graph-newer');
  });
});

describe('SessionRepo — error paths', () => {
  it('save() rethrows after closing datastore', () => {
    datastore.close();
    expect(() => repo.save(makeSession())).toThrow();
  });

  it('list() rethrows after closing datastore', () => {
    datastore.close();
    expect(() => repo.list()).toThrow();
  });

  it('purge() rethrows after closing datastore', () => {
    datastore.close();
    expect(() => repo.purge(new Date())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-Error throwables. Closing the datastore throws a real `Error`, which
// only exercises the `error instanceof Error` true-branch of the catch-block
// log coercion. A backend that throws a bare value (string/object) drives the
// `: String(error)` false-branch — proving the repo coerces any throwable and
// still rethrows the original value verbatim.
// ---------------------------------------------------------------------------

/**
 * Minimal DataStore stub whose db / transaction surface throws a non-Error
 * value. Only the members SessionRepo touches in save/list/purge are present;
 * the rest are stubbed to satisfy the interface.
 */
function throwingDataStore(thrown: unknown): DataStore {
  const explode = (): never => {
    throw thrown;
  };
  return {
    db: {
      select: explode,
      delete: explode,
    },
    transaction: explode,
    close: explode,
  } as unknown as DataStore;
}

describe('SessionRepo — non-Error throwables in catch blocks', () => {
  it('save() rethrows a non-Error value verbatim', () => {
    const repoT = new SessionRepo(throwingDataStore('boom-string'));
    expect(() => repoT.save(makeSession())).toThrow('boom-string');
  });

  it('list() rethrows a non-Error value verbatim', () => {
    const thrown = { code: 'WEIRD' };
    const repoT = new SessionRepo(throwingDataStore(thrown));
    expect(() => repoT.list()).toThrow(); // throws the bare object
    try {
      repoT.list();
    } catch (error) {
      expect(error).toBe(thrown);
    }
  });

  it('purge() rethrows a non-Error value verbatim', () => {
    const repoT = new SessionRepo(throwingDataStore('purge-boom'));
    expect(() => repoT.purge(new Date())).toThrow('purge-boom');
  });
});

// ---------------------------------------------------------------------------
// Optional recipe column. `recipe` is nullable; save() coalesces an absent
// recipe to SQL NULL, and hydrateSession() coalesces a NULL column back to
// `undefined`. Both prior tests always set recipe, so the null/undefined
// sides of those two coalesces went uncovered.
// ---------------------------------------------------------------------------

describe('SessionRepo — optional recipe', () => {
  it('round-trips a session with no recipe (stored NULL, hydrated undefined)', () => {
    const session = makeSession({ id: 'no-recipe', recipe: undefined });
    repo.save(session);
    const fetched = repo.get('no-recipe');
    expect(fetched).not.toBeNull();
    expect(fetched?.recipe).toBeUndefined();
    // The persisted column must be SQL NULL, not the string "undefined".
    const row = datastore.db.select().from(sessions).where(eq(sessions.id, 'no-recipe')).get();
    expect(row?.recipe).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hydration guard — row.tool is stored as plain text (no SQLite CHECK
// constraint), so a legacy or hand-edited row could carry a value outside
// the declared union. The guard turns that silent corruption into an
// explicit throw. (The prior summary-shape guard was removed with the
// session split: contracts no longer knows or validates the payload shape.)
// ---------------------------------------------------------------------------

describe('SessionRepo — hydration guards', () => {
  it('throws on a session row whose tool value is outside the union', () => {
    repo.save(makeSession({ id: 'tool-corrupt' }));
    // Drizzle's `update` lets us poison the row without going through repo.save,
    // which is the only way to simulate a hand-edited / legacy-schema row.
    datastore.db.update(sessions).set({ tool: 'not-a-real-tool' }).run();
    expect(() => repo.get('tool-corrupt')).toThrow(/unknown tool value/);
    expect(() => repo.list()).toThrow(/unknown tool value/);
  });
});
