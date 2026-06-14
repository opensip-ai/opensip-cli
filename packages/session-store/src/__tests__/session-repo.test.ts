import { buildRunDashboardContribution, buildSignalEnvelope } from '@opensip-cli/contracts';
import { DataStoreFactory, type DataStore, type DrizzleDataStore } from '@opensip-cli/datastore';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessions } from '../schema/sessions.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

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
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:00.000Z',
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
    repo.save(
      makeSession({
        id: 'a',
        startedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'b',
        startedAt: '2026-05-02T00:00:00.000Z',
        completedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'c',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:00:00.000Z',
      }),
    );
    const ordered = repo.list();
    expect(ordered.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('honors limit', () => {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(2026, 0, i + 1).toISOString();
      repo.save(makeSession({ id: `s${String(i)}`, startedAt: ts, completedAt: ts }));
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
    repo.save(
      makeSession({
        id: 'old',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'recent',
        startedAt: '2026-05-21T00:00:00.000Z',
        completedAt: '2026-05-21T00:00:00.000Z',
      }),
    );
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
    repo.save(
      makeSession({
        id: 'old',
        startedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'newer',
        startedAt: '2026-05-15T00:00:00.000Z',
        completedAt: '2026-05-15T00:00:00.000Z',
      }),
    );
    expect(repo.latest()?.id).toBe('newer');
  });

  it('returns the most recent session scoped to a tool', () => {
    repo.save(
      makeSession({
        id: 'fit-old',
        tool: 'fit',
        startedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'fit-new',
        tool: 'fit',
        startedAt: '2026-05-02T00:00:00.000Z',
        completedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'graph-newer',
        tool: 'graph',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:00:00.000Z',
      }),
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

// ---------------------------------------------------------------------------
// Per-run dashboard contribution round-trip (host-owned-run-timing Phase 5 §7).
// A tool run builds a ToolDashboardContribution from its envelope via the shared
// declarative builder; the host persists it keyed by (session id, tool) and the
// report composer reads it back for those exact session ids. This proves a
// first-party tool's per-run tab travels the SAME durable seam a third-party
// tool uses, surviving a later `opensip report` process.
// ---------------------------------------------------------------------------

describe('SessionRepo — dashboard contribution round-trip', () => {
  it('round-trips a tool-built ToolDashboardContribution by (session id, tool)', () => {
    const signals: Signal[] = [];
    const envelope = buildSignalEnvelope({
      tool: 'fit',
      recipe: 'default',
      runId: 'run-1',
      createdAt: '2026-06-14T10:00:00.000Z',
      units: [
        { slug: 'check-a', passed: true, violationCount: 0, durationMs: 10 },
        { slug: 'check-b', passed: false, violationCount: 2, durationMs: 20 },
      ],
      signals,
      policy: { failOnErrors: 1, failOnWarnings: 0 },
      runFaulted: false,
    });

    // The tool builds its contribution with the SHARED builder (the same call
    // fit/sim/graph make). Tab ids are namespaced by the idPrefix.
    const contribution = buildRunDashboardContribution(envelope, {
      idPrefix: 'fit',
      label: 'Fitness',
    });
    expect(contribution.tabs?.map((t) => t.id)).toEqual(['fit-run-summary', 'fit-run-units']);

    repo.save(makeSession({ id: 'dash-rt-1', tool: 'fit' }));
    repo.saveDashboardContribution('dash-rt-1', 'fit', contribution);

    const loaded = repo.listDashboardContributions(['dash-rt-1']);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sessionId).toBe('dash-rt-1');
    expect(loaded[0]?.tool).toBe('fit');
    // The opaque contribution round-trips byte-for-byte (verbatim JSON).
    expect(loaded[0]?.contribution).toEqual(contribution);
  });

  it('replaces a prior contribution for the same (session id, tool) pair', () => {
    repo.save(makeSession({ id: 'dash-rt-2', tool: 'sim' }));
    repo.saveDashboardContribution('dash-rt-2', 'sim', { data: { v: 1 }, tabs: [] });
    repo.saveDashboardContribution('dash-rt-2', 'sim', { data: { v: 2 }, tabs: [] });

    const loaded = repo.listDashboardContributions(['dash-rt-2']);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.contribution).toEqual({ data: { v: 2 }, tabs: [] });
  });

  it('returns [] for an empty session-id list', () => {
    expect(repo.listDashboardContributions([])).toEqual([]);
  });
});

describe('SessionRepo — host metrics (upsert merge)', () => {
  it('hydrates host metrics onto the session via get()', () => {
    repo.save(makeSession({ id: 'hm-1' }));
    repo.upsertHostMetrics('hm-1', { persistMs: 12, renderMs: 4 });
    expect(repo.get('hm-1')?.hostMetrics).toEqual({ persistMs: 12, renderMs: 4 });
  });

  it('merges a later upsert onto the existing row instead of nulling prior fields', () => {
    // Regression: the ON CONFLICT update keys are Drizzle column PROPERTIES
    // (camelCase), not SQL column names — a snake_case `set` silently no-ops the
    // merge, so the second write (e.g. live-path ttyBusyMs) would be lost.
    repo.save(makeSession({ id: 'hm-2' }));
    repo.upsertHostMetrics('hm-2', { persistMs: 9 }); // first write (insert)
    repo.upsertHostMetrics('hm-2', { ttyBusyMs: 21, renderMs: 3 }); // conflict → merge

    expect(repo.get('hm-2')?.hostMetrics).toEqual({
      persistMs: 9, // survives the merge
      ttyBusyMs: 21, // added by the conflicting upsert
      renderMs: 3,
    });
  });

  it('overwrites a previously-set field when the same key is upserted again', () => {
    repo.save(makeSession({ id: 'hm-3' }));
    repo.upsertHostMetrics('hm-3', { persistMs: 5 });
    repo.upsertHostMetrics('hm-3', { persistMs: 50 });
    expect(repo.get('hm-3')?.hostMetrics?.persistMs).toBe(50);
  });

  it('is a no-op for an empty metrics object (no row created)', () => {
    repo.save(makeSession({ id: 'hm-4' }));
    repo.upsertHostMetrics('hm-4', {});
    expect(repo.get('hm-4')?.hostMetrics).toBeUndefined();
  });
});
