import { buildSignalEnvelope } from '@opensip-cli/contracts';
import {
  HOST_VERDICT_POLICY_FALLBACK,
  RunScope,
  runWithScope,
  runWithScopeSync,
  type Logger,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { listSessionSummaries, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
  runWithSuiteRunContext,
  type RunPlaneFactory,
} from '../run-plane.js';
import * as retentionModule from '../session-retention.js';

const SILENT: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function contribution(overrides: Partial<ToolSessionContribution> = {}): ToolSessionContribution {
  return {
    tool: 'fit',
    cwd: '/project',
    score: 92,
    passed: true,
    payload: { summary: { total: 3 } },
    ...overrides,
  };
}

function envelope(passed = true) {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'fit-run',
    createdAt: '2026-07-16T00:00:00.000Z',
    units: [{ slug: 'fit', passed, durationMs: 1 }],
    signals: [],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

describe('run-plane staging lifecycle', () => {
  it('creates the lifecycle lazily and reuses it for one invocation', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const afterConstruction = Date.now();
    const first = factory.beginRun();
    expect(first).toBe(factory.current());
    expect(first.lifecycle.startedAtEpochMs).toBeGreaterThanOrEqual(afterConstruction);
  });

  it('preallocates identity and freezes an immutable Session before persistence', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const payload = { summary: { total: 3 } };
      const invocation = factory.current();
      const staged = invocation.completeAndStage(contribution({ payload }));

      expect(staged?.id).toBe(invocation.sessionId());
      expect(staged?.startedAt).toBe(invocation.lifecycle.startedAt);
      expect(staged?.durationMs).toBeGreaterThanOrEqual(0);
      expect(new SessionRepo(datastore).count()).toBe(0);

      payload.summary.total = 999;
      expect(staged?.payload).toEqual({ summary: { total: 3 } });

      const result = await factory.finalizeCurrent();
      expect(result.status).toBe('committed');
      const row = new SessionRepo(datastore).get(staged!.id);
      expect(row).toMatchObject({
        id: staged?.id,
        tool: 'fit',
        score: 92,
        passed: true,
        payload: { summary: { total: 3 } },
      });
      expect(row?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(0);
    } finally {
      datastore.close();
    }
  });

  it('freezes lifecycle and contribution exactly once', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const invocation = factory.current();
    const first = invocation.completeAndStage(contribution());
    const second = invocation.completeAndStage(contribution({ tool: 'graph' }));
    expect(second).toBe(first);
    expect(second?.tool).toBe('fit');
    expect(second?.completedAt).toBe(first?.completedAt);
  });

  it('stages without a datastore and discards only at best-effort finalization', async () => {
    const resolver = vi.fn(() => undefined);
    const factory = createRunPlaneFactory({ getDatastore: resolver, logger: SILENT });
    const invocation = factory.current();
    expect(invocation.completeAndStage(contribution())).toBeDefined();
    expect(invocation.sessionId()).toBeDefined();
    await expect(factory.finalizeCurrent()).resolves.toEqual({
      status: 'datastore-unavailable',
    });
    expect(invocation.sessionId()).toBeUndefined();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('does not resolve/open a datastore for a truly empty no-run/no-report action', async () => {
    const resolver = vi.fn(() => {
      throw new Error('must not open');
    });
    const factory = createRunPlaneFactory({ getDatastore: resolver, logger: SILENT });
    await expect(factory.finalizeCurrent()).resolves.toEqual({ status: 'discarded' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('stamps manifest provenance and suite grouping before drain', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const scope = new RunScope({
        toolManifests: [{ id: 'fit', identity: { name: 'fit' }, version: '9.9.9' }] as never,
      });
      let id: string | undefined;
      await runWithScope(scope, () =>
        runWithSuiteRunContext({ suiteRunId: 'suite-1', suiteName: 'security' }, async () => {
          id = factory.current().completeAndStage(contribution())?.id;
          await factory.finalizeCurrent();
        }),
      );
      expect(new SessionRepo(datastore).get(id!)).toMatchObject({
        engineVersion: '9.9.9',
        suiteRunId: 'suite-1',
        suiteName: 'security',
      });
    } finally {
      datastore.close();
    }
  });

  it('keeps a committed Session ID observable for the legacy suite review handoff', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const hooks = createRunActionHooks(factory);
      await runWithSuiteRunContext({ suiteRunId: 'suite-legacy', suiteName: 'audit' }, async () => {
        hooks.completeRun?.({ session: contribution() });
        const stagedId = hooks.currentSessionId?.();
        expect(stagedId).toBeDefined();
        await hooks.finalizeRun?.();
        expect(hooks.currentSessionId?.()).toBe(stagedId);
        expect(hooks.currentStagedSession?.()?.id).toBe(stagedId);
      });
    } finally {
      datastore.close();
    }
  });

  it('merges host metrics before the atomic commit', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const invocation = factory.current();
      const id = invocation.completeAndStage(contribution())!.id;
      invocation.recordHostMetrics({ renderMs: 7 });
      invocation.recordHostMetrics({ egressMs: 3 });
      await factory.finalizeCurrent();
      expect(new SessionRepo(datastore).get(id)?.hostMetrics).toMatchObject({
        renderMs: 7,
        egressMs: 3,
        persistMs: expect.any(Number),
      });
    } finally {
      datastore.close();
    }
  });

  it('ignores metrics recorded after drain without hiding committed evidence', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const invocation = factory.current();
      const id = invocation.completeAndStage(contribution())!.id;
      await factory.finalizeCurrent();

      invocation.recordHostMetrics({ renderMs: 99 });

      expect(invocation.sessionId()).toBe(id);
      expect(invocation.sessionStagingStatus()).toBe('staged');
      expect(new SessionRepo(datastore).get(id)?.hostMetrics?.renderMs).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('marks metrics-driven byte poison rejected and unlinks the identity', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({
        getDatastore: () => datastore,
        evidenceLimits: { maxBytes: 380 },
        logger: SILENT,
      });
      const invocation = factory.current();
      invocation.completeAndStage(contribution({ payload: null }));
      expect(invocation.sessionStagingStatus()).toBe('staged');
      invocation.recordHostMetrics({
        totalCommandMs: 'x'.repeat(500),
      } as unknown as Parameters<typeof invocation.recordHostMetrics>[0]);
      expect(invocation.sessionStagingStatus()).toBe('rejected');
      expect(invocation.sessionId()).toBeUndefined();
      expect(await factory.finalizeCurrent()).toMatchObject({ status: 'poisoned' });
      expect(new SessionRepo(datastore).count()).toBe(0);
    } finally {
      datastore.close();
    }
  });
});

describe('nested evidence owners', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
  });
  afterEach(() => datastore.close());

  it('retains accepted children across invocation reset and defers ordinary finalization', async () => {
    const owner = factory.createNestedEvidenceOwner();
    const ids: string[] = [];
    await runWithSuiteRunContext(
      { suiteRunId: 'suite-1', suiteName: 'audit', evidenceOwner: owner },
      async () => {
        ids.push(factory.current().completeAndStage(contribution({ tool: 'fit' }))!.id);
        expect(await factory.finalizeCurrent()).toEqual({ status: 'deferred' });
        factory.reset();
        ids.push(factory.current().completeAndStage(contribution({ tool: 'graph' }))!.id);
      },
    );
    expect(new SessionRepo(datastore).count()).toBe(0);
    const result = await factory.finalizeEvidenceOwner(owner);
    expect(result).toMatchObject({ status: 'committed', sessionCount: 2 });
    expect(ids.map((id) => new SessionRepo(datastore).get(id)?.tool)).toEqual(['fit', 'graph']);
  });

  it('discards only a capability-mismatched current invocation', async () => {
    const hooks = createRunActionHooks(factory);
    const owner = hooks.createNestedEvidenceOwner!();
    runWithSuiteRunContext(
      { suiteRunId: 'suite-1', suiteName: 'audit', evidenceOwner: owner },
      () => {
        hooks.beginRun?.();
        hooks.completeRun?.({ session: contribution({ tool: 'fit' }) });
        hooks.resetRun?.();
        hooks.beginRun?.();
        hooks.completeRun?.({ session: contribution({ tool: 'graph' }) });
        expect(hooks.currentSessionStagingStatus?.()).toBe('staged');
        hooks.discardCurrentInvocationEvidence?.();
        expect(hooks.currentSessionStagingStatus?.()).toBe('discarded');
      },
    );
    const result = await hooks.finalizeEvidenceOwner!(owner);
    expect(result).toMatchObject({ status: 'committed', sessionCount: 1 });
    expect(new SessionRepo(datastore).list().map((row) => row.tool)).toEqual(['fit']);
  });

  it('aborts a nested owner without drain or prefix commit', async () => {
    const hooks = createRunActionHooks(factory);
    const owner = hooks.createNestedEvidenceOwner!();
    runWithSuiteRunContext(
      { suiteRunId: 'suite-1', suiteName: 'audit', evidenceOwner: owner },
      () => {
        hooks.completeRun?.({ session: contribution() });
      },
    );
    hooks.discardEvidenceOwner?.(owner);
    expect(await hooks.finalizeEvidenceOwner!(owner)).toEqual({ status: 'discarded' });
    expect(new SessionRepo(datastore).count()).toBe(0);
  });
});

describe('live completion and immutable envelope capture', () => {
  it('stages live evidence, records ttyBusyMs, and strips only Session', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const signalEnvelope = envelope();
      const completion: ToolRunCompletion = {
        session: contribution(),
        envelope: signalEnvelope,
        result: { done: true },
        execution: { kind: 'delegated', startedAt: '2026-07-16T00:00:00.000Z' },
      };
      const output = await factory.current().completeLiveRender(() => Promise.resolve(completion));
      expect(output).toEqual({
        envelope: signalEnvelope,
        result: { done: true },
        execution: { kind: 'delegated', startedAt: '2026-07-16T00:00:00.000Z' },
      });
      const id = factory.current().sessionId()!;
      expect(new SessionRepo(datastore).count()).toBe(0);
      await factory.finalizeCurrent();
      expect(new SessionRepo(datastore).get(id)?.hostMetrics?.ttyBusyMs).toBeGreaterThanOrEqual(0);
    } finally {
      datastore.close();
    }
  });

  it('captures bounded immutable envelope facts before later mutation', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const hooks = createRunActionHooks(factory);
    const mutable = envelope() as unknown as {
      verdict: { passed: boolean; summary: { errors: number } };
      signals: unknown[];
    };
    hooks.completeRun?.({ envelope: mutable });
    mutable.verdict.passed = false;
    mutable.verdict.summary.errors = 99;
    mutable.signals.push({ fingerprint: 'late' });
    expect(hooks.currentStagedEnvelope?.()).toMatchObject({
      passed: true,
      errors: 0,
      findings: 0,
      evidence: { signalCount: 0 },
    });
  });

  it('bounds fingerprint sampling for very large arrays and ignores malformed envelopes', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const hooks = createRunActionHooks(factory);
    const huge = envelope() as unknown as { signals: { fingerprint: string }[] };
    huge.signals = Array.from({ length: 50_000 }, (_, index) => ({
      fingerprint: `fp-${index}`,
    }));
    expect(() => hooks.completeRun?.({ envelope: huge })).not.toThrow();
    const evidence = hooks.currentStagedEnvelope?.().evidence as {
      readonly fingerprints?: readonly string[];
      readonly signalCount?: number;
    };
    expect(evidence.signalCount).toBe(50_000);
    expect(evidence.fingerprints).toHaveLength(20);

    hooks.resetRun?.();
    expect(() =>
      hooks.completeRun?.({
        envelope: {
          ...envelope(),
          verdict: { passed: true, score: Number.NaN, summary: null },
        },
      }),
    ).not.toThrow();
    expect(hooks.currentStagedEnvelope?.()).toBeUndefined();
  });
});

describe('finalizer side effects', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    datastore.close();
  });

  it.each(['committed', 'precondition-rejected', 'failed', 'poisoned'] as const)(
    'runs retention exactly once after a %s attempt',
    async (mode) => {
      const retention = vi
        .spyOn(retentionModule, 'enforceSessionRetention')
        .mockImplementation(() => ({ deleted: 0 }) as never);
      const factory = createRunPlaneFactory({
        getDatastore: () => datastore,
        ...(mode === 'failed'
          ? {
              commitEvidence: () => ({ status: 'failed', reason: 'write-failed' }) as const,
            }
          : {}),
        ...(mode === 'precondition-rejected'
          ? {
              commitEvidence: () => ({ status: 'precondition-rejected' }) as const,
            }
          : {}),
        ...(mode === 'poisoned' ? { evidenceLimits: { maxSessions: 0 } } : {}),
        logger: SILENT,
      });
      factory.current().completeAndStage(contribution());
      await factory.finalizeCurrent();
      expect(retention).toHaveBeenCalledOnce();
    },
  );

  it('commits, opens, retains, and cleans up only once across repeated finalization', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const retention = vi
      .spyOn(retentionModule, 'enforceSessionRetention')
      .mockImplementation(() => ({ deleted: 0 }) as never);
    const factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      executeReportEffect: execute,
      logger: SILENT,
    });
    factory.current().completeAndStage(contribution());
    factory.queueReportEffect({ kind: 'compose-and-open' });
    const first = factory.finalizeCurrent();
    const second = factory.finalizeCurrent();
    expect(await second).toBe(await first);
    expect(new SessionRepo(datastore).count()).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(retention).toHaveBeenCalledOnce();
  });

  it('waits for deferred report completion before retention', async () => {
    let finishReport: (() => void) | undefined;
    let markReportStarted: (() => void) | undefined;
    const reportStarted = new Promise<void>((resolve) => {
      markReportStarted = resolve;
    });
    const reportRelease = new Promise<void>((resolve) => {
      finishReport = resolve;
    });
    const events: string[] = [];
    const retention = vi
      .spyOn(retentionModule, 'enforceSessionRetention')
      .mockImplementation(() => {
        events.push('retain');
        return { deleted: 0 } as never;
      });
    const factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      executeReportEffect: async () => {
        events.push('report-start');
        markReportStarted?.();
        await reportRelease;
        events.push('report-finish');
      },
      logger: SILENT,
    });
    const invocation = factory.current();
    const id = invocation.completeAndStage(contribution())!.id;
    factory.queueReportEffect({ kind: 'compose-and-open' });

    const finalizing = factory.finalizeCurrent();
    await reportStarted;
    expect(events).toEqual(['report-start']);
    expect(invocation.sessionId()).toBeDefined();
    expect(retention).not.toHaveBeenCalled();

    finishReport?.();
    await finalizing;
    expect(events).toEqual(['report-start', 'report-finish', 'retain']);
    expect(invocation.sessionId()).toBe(id);
  });

  it('discards the report request after rollback', async () => {
    const execute = vi.fn(() => Promise.resolve());
    const factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      executeReportEffect: execute,
      commitEvidence: () => ({ status: 'failed', reason: 'write-failed' }),
      logger: SILENT,
    });
    factory.current().completeAndStage(contribution());
    factory.queueReportEffect({ kind: 'compose-and-open' });
    expect(await factory.finalizeCurrent()).toEqual({
      status: 'failed',
      reason: 'write-failed',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('presents deferred report failure while preserving the committed verdict', async () => {
    const failure = vi.fn(() => Promise.resolve());
    const factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      executeReportEffect: () => Promise.reject(new TypeError('private path')),
      onReportEffectFailure: failure,
      logger: SILENT,
    });
    factory.current().completeAndStage(contribution());
    factory.queueReportEffect({ kind: 'compose-and-open' });
    expect(await factory.finalizeCurrent()).toMatchObject({ status: 'committed' });
    expect(failure).toHaveBeenCalledWith({
      effect: { kind: 'compose-and-open' },
      errorName: 'TypeError',
    });
  });
});

describe('run action hooks and session reads', () => {
  it('round-trips a staged failing verdict only after finalization', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const factory = createRunPlaneFactory({ getDatastore: () => datastore, logger: SILENT });
      const hooks = createRunActionHooks(factory);
      hooks.beginRun?.();
      hooks.completeRun?.({
        session: contribution({
          tool: 'yagni',
          passed: false,
          score: 0,
          payload: {
            summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 1 },
          },
        }),
      });
      expect(listSessionSummaries(datastore).sessions).toHaveLength(0);
      await hooks.finalizeRun?.();
      expect(listSessionSummaries(datastore, { summaryOnly: true }).sessions[0]).toMatchObject({
        tool: 'yagni',
        passed: false,
        runOutcome: 'failed',
        summary: { total: 1, warnings: 1 },
      });
    } finally {
      datastore.close();
    }
  });

  it('exposes the same lifecycle through the read-only runSession seam', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    expect(createRunSessionSeam(factory).timing).toBe(factory.current().lifecycle);
  });

  it('captures engine version from the entered scope before staging', () => {
    const factory = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
    const scope = new RunScope({
      toolManifests: [{ id: 'fit', identity: { name: 'fit' }, version: '1.2.3' }] as never,
    });
    const staged = runWithScopeSync(scope, () =>
      factory.current().completeAndStage(contribution()),
    );
    expect(staged?.engineVersion).toBe('1.2.3');
  });
});
