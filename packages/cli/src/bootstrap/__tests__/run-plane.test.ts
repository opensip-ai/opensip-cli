/**
 * Narrow unit coverage for the host run-lifecycle plane (host-owned-run-timing
 * Phase 6 §6.1 / Task 6.2). Exercises the plane in isolation with an in-memory
 * datastore (or none): contribution → persisted `StoredSession` row with the
 * host-stamped timing fields, host-metric accumulation, the best-effort
 * never-throw contract, and the two glue helpers (`createRunSessionSeam` /
 * `createRunActionHooks`) the assembler wires into the context.
 */

import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
  type RunPlaneFactory,
} from '../run-plane.js';

import type { Logger, ToolRunCompletion, ToolSessionContribution } from '@opensip-cli/core';

/** Silent logger so the best-effort warn/info paths don't spam test output. */
const SILENT: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function contribution(overrides: Partial<ToolSessionContribution> = {}): ToolSessionContribution {
  return {
    tool: 'fit',
    cwd: '/proj',
    score: 92,
    passed: true,
    payload: { summary: { total: 3 } },
    ...overrides,
  };
}

describe('createRunPlaneFactory — invocation lifecycle', () => {
  it('beginRun and current return the same single invocation', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const a = factory.beginRun();
    const b = factory.current();
    expect(b).toBe(a);
    expect(a.lifecycle.startedAt).toBe(b.lifecycle.startedAt);
  });

  it('completeAndPersist is best-effort with no datastore — returns undefined, never throws', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const inv = factory.current();
    expect(inv.completeAndPersist(contribution())).toBeUndefined();
    expect(inv.sessionId()).toBeUndefined();
  });

  it('swallows a persistence failure (broken datastore) and returns undefined', () => {
    // A datastore whose `.db` is absent makes SessionRepo.save throw; the plane
    // must degrade to undefined rather than propagate.
    const factory = createRunPlaneFactory({
      getDatastore: () => ({}) as DataStore,
      logger: SILENT,
    });
    const inv = factory.current();
    expect(() => inv.completeAndPersist(contribution())).not.toThrow();
    expect(inv.completeAndPersist(contribution())).toBeUndefined();
    expect(inv.sessionId()).toBeUndefined();
  });
});

describe('createRunPlaneFactory — persistence (in-memory datastore)', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
  });
  afterEach(() => {
    datastore.close();
  });

  it('persists a StoredSession with host-stamped timing + the tool contribution', () => {
    const inv = factory.current();
    const recorded = inv.completeAndPersist(contribution({ recipe: 'example' }));

    expect(recorded).toBeDefined();
    expect(recorded?.tool).toBe('fit');
    expect(inv.sessionId()).toBe(recorded?.id);
    // The host stamps timing from the lifecycle; the snapshot is frozen by complete().
    expect(recorded?.startedAt).toBe(inv.lifecycle.startedAt);
    expect(recorded?.durationMs).toBeGreaterThanOrEqual(0);

    const repo = new SessionRepo(datastore);
    const row = repo.get(recorded!.id);
    expect(row).not.toBeNull();
    expect(row?.tool).toBe('fit');
    expect(row?.recipe).toBe('example');
    expect(row?.score).toBe(92);
    expect(row?.passed).toBe(true);
    expect(row?.startedAt).toBe(recorded?.startedAt);
    expect(row?.completedAt).toBe(recorded?.completedAt);
    expect(row?.durationMs).toBe(recorded?.durationMs);
    expect(row?.payload).toEqual({ summary: { total: 3 } });
  });

  it('records persistMs on the sibling host-metrics row', () => {
    const inv = factory.current();
    const recorded = inv.completeAndPersist(contribution());
    const row = new SessionRepo(datastore).get(recorded!.id);
    expect(row?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(0);
  });

  it('freezes the lifecycle so a second persist reuses the same completion snapshot', () => {
    const inv = factory.current();
    const first = inv.completeAndPersist(contribution());
    const second = inv.completeAndPersist(contribution({ tool: 'graph' }));
    // Different rows (different ids), identical frozen timing.
    expect(second?.id).not.toBe(first?.id);
    expect(second?.startedAt).toBe(first?.startedAt);
    expect(second?.completedAt).toBe(first?.completedAt);
    expect(second?.durationMs).toBe(first?.durationMs);
  });

  it('recordHostMetrics is a no-op before a session row exists', () => {
    const inv = factory.current();
    expect(() => inv.recordHostMetrics({ renderMs: 5 })).not.toThrow();
    // No row was written, so nothing to read back.
    expect(inv.sessionId()).toBeUndefined();
  });

  it('recordHostMetrics upserts onto the persisted session', () => {
    const inv = factory.current();
    const recorded = inv.completeAndPersist(contribution());
    inv.recordHostMetrics({ renderMs: 7, egressMs: 3 });
    const row = new SessionRepo(datastore).get(recorded!.id);
    expect(row?.hostMetrics?.renderMs).toBe(7);
    expect(row?.hostMetrics?.egressMs).toBe(3);
    // persistMs from the original write survives the upsert merge.
    expect(row?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(0);
  });

  it('persists a dashboard contribution keyed by the session id', () => {
    const inv = factory.current();
    const dashboard = {
      tabs: [{ id: 't', title: 'T', view: { kind: 'table' as const, columns: [] } }],
      data: {},
    };
    const recorded = inv.completeAndPersist(contribution(), dashboard);
    const rows = new SessionRepo(datastore).listDashboardContributions([recorded!.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(recorded?.id);
    expect(rows[0]?.tool).toBe('fit');
  });
});

describe('completeLiveRender', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
  });
  afterEach(() => {
    datastore.close();
  });

  it('returns the completion unchanged and persists its session + ttyBusyMs', async () => {
    const inv = factory.current();
    const completion: ToolRunCompletion = { session: contribution() };
    const out = await inv.completeLiveRender(() => Promise.resolve(completion));
    expect(out).toBe(completion);
    const id = inv.sessionId();
    expect(id).toBeDefined();
    const row = new SessionRepo(datastore).get(id!);
    expect(row?.tool).toBe('fit');
    expect(row?.hostMetrics?.ttyBusyMs).toBeGreaterThanOrEqual(0);
  });

  it('persists nothing when the renderer returns void', async () => {
    const inv = factory.current();
    const out = await inv.completeLiveRender(() => Promise.resolve());
    expect(out).toBeUndefined();
    expect(inv.sessionId()).toBeUndefined();
  });
});

describe('createRunSessionSeam', () => {
  it('exposes the current invocation lifecycle as `timing`', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const seam = createRunSessionSeam(factory);
    expect(seam.timing).toBe(factory.current().lifecycle);
  });
});

describe('createRunActionHooks', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
  });
  afterEach(() => {
    datastore.close();
  });

  it('completeRun persists when the result carries a session contribution', () => {
    const hooks = createRunActionHooks(factory);
    hooks.beginRun?.();
    hooks.completeRun?.({ session: contribution() } satisfies ToolRunCompletion);
    expect(factory.current().sessionId()).toBeDefined();
  });

  it('completeRun is a no-op for a plain CommandResult (no session)', () => {
    const hooks = createRunActionHooks(factory);
    hooks.completeRun?.({ type: 'help' });
    expect(factory.current().sessionId()).toBeUndefined();
  });
});
