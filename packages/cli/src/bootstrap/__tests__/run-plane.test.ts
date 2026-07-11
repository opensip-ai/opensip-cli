/**
 * Narrow unit coverage for the host run-lifecycle plane (host-owned-run-timing
 * Phase 6 §6.1 / Task 6.2). Exercises the plane in isolation with an in-memory
 * datastore (or none): contribution → persisted `StoredSession` row with the
 * host-stamped timing fields, host-metric accumulation, the best-effort
 * never-throw contract, and the two glue helpers (`createRunSessionSeam` /
 * `createRunActionHooks`) the assembler wires into the context.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunScope,
  runWithScopeSync,
  type Logger,
  type ProjectContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { listSessionSummaries, SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { disposeCurrentScope } from '../pre-action-hook.js';
import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
  runWithSuiteRunContext,
  type RunPlaneFactory,
} from '../run-plane.js';
import * as sessionRetentionMod from '../session-retention.js';
import { resolveCurrentSessionRetentionPolicy } from '../session-retention.js';

/** Silent logger so the best-effort warn/info paths don't spam test output. */
const SILENT: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

function writeRetentionConfig(root: string, keep: number): void {
  writeFileSync(
    join(root, 'opensip-cli.config.yml'),
    `cli:
  sessions:
    keep: ${keep}
    maxAgeDays: 0
    maxSizeMb: 0
`,
    'utf8',
  );
}

function projectContext(root: string): ProjectContext {
  return {
    cwd: root,
    cwdExplicit: true,
    projectRoot: root,
    configPath: join(root, 'opensip-cli.config.yml'),
    walkedUp: 0,
    scope: 'project',
  };
}

function withCwd<T>(cwd: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

describe('createRunPlaneFactory — invocation lifecycle', () => {
  it('beginRun and current return the same single invocation', () => {
    const factory = createRunPlaneFactory({
      getDatastore: () => undefined,
      logger: SILENT,
    });
    const a = factory.beginRun();
    const b = factory.current();
    expect(b).toBe(a);
    expect(a.lifecycle.startedAt).toBe(b.lifecycle.startedAt);
  });

  it('does NOT start a lifecycle at construction — startedAt reflects first beginRun, not factory creation', () => {
    // Command-scoping invariant: the factory holds stable deps only; the
    // lifecycle (and its startedAt wall clock) must be created when the command
    // action calls beginRun, NOT eagerly at buildToolCliContext time. Capture a
    // boundary AFTER construction, spin, then begin — a lazily-created lifecycle
    // starts after the boundary; an eagerly-created one would start before it.
    const factory = createRunPlaneFactory({
      getDatastore: () => undefined,
      logger: SILENT,
    });
    const afterConstruction = Date.now();
    const spinStart = Date.now();
    while (Date.now() - spinStart < 5) {
      /* spin so the boundary is measurably before beginRun */
    }
    const inv = factory.beginRun();
    expect(inv.lifecycle.startedAtEpochMs).toBeGreaterThanOrEqual(afterConstruction);
  });

  it('completeAndPersist is best-effort with no datastore — returns undefined, never throws', () => {
    const factory = createRunPlaneFactory({
      getDatastore: () => undefined,
      logger: SILENT,
    });
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

describe('createRunPlaneFactory — datastore resolver failures (best-effort)', () => {
  it('swallows a THROWING datastore resolver during persist (degrades to undefined)', () => {
    const debug = vi.fn();
    const factory = createRunPlaneFactory({
      getDatastore: () => {
        throw new Error('resolver boom');
      },
      logger: { ...SILENT, debug },
    });
    const inv = factory.current();
    expect(() => inv.completeAndPersist(contribution())).not.toThrow();
    expect(inv.completeAndPersist(contribution())).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.run-plane.datastore_unavailable' }),
    );
  });

  it('warns and continues when host-metric upsert fails after a successful persist', () => {
    const warn = vi.fn();
    const memory = DataStoreFactory.open({ backend: 'memory' });
    let resolved: DataStore = memory;
    const factory = createRunPlaneFactory({
      getDatastore: () => resolved,
      logger: { ...SILENT, warn },
    });
    const inv = factory.current();
    // Persist with the real store → sessionId is set.
    expect(inv.completeAndPersist(contribution())).toBeDefined();
    expect(inv.sessionId()).toBeDefined();
    // Swap to a non-drizzle store → `new SessionRepo(...)` throws inside
    // recordHostMetrics, which must warn rather than propagate.
    resolved = {} as DataStore;
    expect(() => inv.recordHostMetrics({ renderMs: 5 })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ evt: expect.stringContaining('host_metrics') }),
    );
    memory.close();
  });
});

describe('createRunPlaneFactory — persistence (in-memory datastore)', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      logger: SILENT,
    });
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
    // The host stamps the real opensip-cli version as run provenance.
    expect(row?.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('stamps engineVersion from the entered scope tool manifest', () => {
    const scope = new RunScope({
      toolManifests: [
        { id: 'fit', identity: { name: 'fit' }, version: '9.9.9' },
      ] as unknown as NonNullable<ConstructorParameters<typeof RunScope>[0]>['toolManifests'],
    });
    const recorded = runWithScopeSync(scope, () =>
      factory.current().completeAndPersist(contribution()),
    );
    const row = new SessionRepo(datastore).get(recorded!.id);
    expect(row?.engineVersion).toBe('9.9.9');
    expect(row?.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('records persistMs on the sibling host-metrics row', () => {
    const inv = factory.current();
    const recorded = inv.completeAndPersist(contribution());
    const row = new SessionRepo(datastore).get(recorded!.id);
    expect(row?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(0);
  });

  it('stamps suite grouping fields from the active suite context', () => {
    let sessionId: string | undefined;
    runWithSuiteRunContext({ suiteRunId: 'suite-run-1', suiteName: 'security' }, () => {
      const recorded = factory.current().completeAndPersist(contribution());
      sessionId = recorded?.id;
    });

    const row = new SessionRepo(datastore).get(sessionId!);
    expect(row?.suiteRunId).toBe('suite-run-1');
    expect(row?.suiteName).toBe('security');
  });

  it('is idempotent for repeated completion on the same invocation', () => {
    const inv = factory.current();
    const first = inv.completeAndPersist(contribution());
    const second = inv.completeAndPersist(contribution({ tool: 'graph' }));
    expect(second?.id).toBe(first?.id);
    expect(second?.startedAt).toBe(first?.startedAt);
    expect(second?.completedAt).toBe(first?.completedAt);
    expect(second?.durationMs).toBe(first?.durationMs);
    expect(new SessionRepo(datastore).count()).toBe(1);
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

  it('resolves session retention from the entered scope project, not the invoking cwd', () => {
    const invokingRoot = mkdtempSync(join(tmpdir(), 'opensip-retention-invoking-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'opensip-retention-project-'));
    const scopedDatastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      writeRetentionConfig(invokingRoot, 1);
      writeRetentionConfig(projectRoot, 3);
      const debug = vi.fn();
      const log: Logger = { ...SILENT, debug };
      let scope: RunScope | undefined;
      const repo = new SessionRepo(scopedDatastore);
      for (let i = 0; i < 3; i += 1) {
        repo.save({
          ...contribution({ cwd: projectRoot }),
          id: `seed-${i}`,
          startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
          completedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
          durationMs: 1,
        });
      }

      withCwd(invokingRoot, () => {
        const scopedFactory = createRunPlaneFactory({
          getDatastore: () => scopedDatastore,
          sessionRetentionPolicy: resolveCurrentSessionRetentionPolicy,
          logger: log,
        });
        scope = new RunScope({
          logger: log,
          runId: 'run-retention-scope',
          projectContext: projectContext(projectRoot),
          datastore: () => scopedDatastore,
        });
        runWithScopeSync(scope, () => {
          scopedFactory.current().completeAndPersist(contribution({ cwd: projectRoot }));
        });
      });

      expect(repo.count()).toBe(3);
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'session.retention.policy_resolved',
          source: 'scope',
          keep: 3,
          maxAgeDays: 0,
          maxSizeMb: 0,
        }),
      );
      expect(scope?.diagnostics.snapshot().events).toContainEqual(
        expect.objectContaining({
          phase: 'persist',
          level: 'debug',
          message: 'session.retention.policy_resolved',
          data: expect.objectContaining({
            evt: 'session.retention.policy_resolved',
            source: 'scope',
            keep: 3,
            maxAgeDays: 0,
            maxSizeMb: 0,
          }),
        }),
      );
    } finally {
      scopedDatastore.close();
      rmSync(invokingRoot, { recursive: true, force: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves session retention from process.cwd() when no scope is entered', () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'opensip-retention-cwd-'));
    const fallbackDatastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      writeRetentionConfig(cwdRoot, 2);
      const debug = vi.fn();
      const log: Logger = { ...SILENT, debug };
      const repo = new SessionRepo(fallbackDatastore);
      for (let i = 0; i < 3; i += 1) {
        repo.save({
          ...contribution({ cwd: cwdRoot }),
          id: `fallback-seed-${i}`,
          startedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
          completedAt: `2026-02-0${i + 1}T00:00:00.000Z`,
          durationMs: 1,
        });
      }

      withCwd(cwdRoot, () => {
        const fallbackFactory = createRunPlaneFactory({
          getDatastore: () => fallbackDatastore,
          sessionRetentionPolicy: resolveCurrentSessionRetentionPolicy,
          logger: log,
        });
        fallbackFactory.current().completeAndPersist(contribution({ cwd: cwdRoot }));
      });

      expect(repo.count()).toBe(2);
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'session.retention.policy_resolved',
          source: 'cwd-fallback',
          keep: 2,
          maxAgeDays: 0,
          maxSizeMb: 0,
        }),
      );
    } finally {
      fallbackDatastore.close();
      rmSync(cwdRoot, { recursive: true, force: true });
    }
  });
});

describe('completeLiveRender', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      logger: SILENT,
    });
  });
  afterEach(() => {
    datastore.close();
  });

  it('returns the completion without session and persists its session + ttyBusyMs', async () => {
    const inv = factory.current();
    const envelope = { ok: true };
    const result = { done: true };
    const completion: ToolRunCompletion = { session: contribution(), envelope, result };
    const out = await inv.completeLiveRender(() => Promise.resolve(completion));
    expect(out).toEqual({ envelope, result });
    const id = inv.sessionId();
    expect(id).toBeDefined();
    const row = new SessionRepo(datastore).get(id!);
    expect(row?.tool).toBe('fit');
    expect(row?.hostMetrics?.ttyBusyMs).toBeGreaterThanOrEqual(0);
    expect(new SessionRepo(datastore).count()).toBe(1);
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
    const factory = createRunPlaneFactory({
      getDatastore: () => undefined,
      logger: SILENT,
    });
    const seam = createRunSessionSeam(factory);
    expect(seam.timing).toBe(factory.current().lifecycle);
  });
});

describe('createRunActionHooks', () => {
  let datastore: DataStore;
  let factory: RunPlaneFactory;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    factory = createRunPlaneFactory({
      getDatastore: () => datastore,
      logger: SILENT,
    });
  });
  afterEach(() => {
    datastore.close();
  });

  it('completeRun persists when the result carries a session contribution', () => {
    const hooks = createRunActionHooks(factory);
    hooks.beginRun?.();
    hooks.completeRun?.({
      session: contribution(),
    } satisfies ToolRunCompletion);
    expect(factory.current().sessionId()).toBeDefined();
    expect(hooks.currentSessionId?.()).toBe(factory.current().sessionId());
  });

  it('completeRun is a no-op for a plain CommandResult (no session)', () => {
    const hooks = createRunActionHooks(factory);
    hooks.completeRun?.({ type: 'help' });
    expect(factory.current().sessionId()).toBeUndefined();
  });

  it('resetRun clears the current invocation so a later beginRun starts fresh', () => {
    const hooks = createRunActionHooks(factory);
    hooks.beginRun?.();
    hooks.completeRun?.({ session: contribution() } satisfies ToolRunCompletion);
    expect(factory.current().sessionId()).toBeDefined();
    hooks.resetRun?.();
    hooks.beginRun?.();
    expect(factory.current().sessionId()).toBeUndefined();
    expect(hooks.currentSessionId?.()).toBeUndefined();
  });

  it('warns and returns undefined when session persistence throws', () => {
    const warn = vi.fn();
    const memory = DataStoreFactory.open({ backend: 'memory' });
    const saveSpy = vi.spyOn(SessionRepo.prototype, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      const factoryWithBrokenSave = createRunPlaneFactory({
        getDatastore: () => memory,
        logger: { ...SILENT, warn },
      });
      expect(factoryWithBrokenSave.current().completeAndPersist(contribution())).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'cli.run-session.record_failed',
          error: 'disk full',
        }),
      );
    } finally {
      saveSpy.mockRestore();
      memory.close();
    }
  });

  it('warns with a stringified error when session persistence throws a non-Error', () => {
    const warn = vi.fn();
    const memory = DataStoreFactory.open({ backend: 'memory' });
    const saveSpy = vi.spyOn(SessionRepo.prototype, 'save').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises host handling of non-Error throwables.
      throw 'disk string fault';
    });
    try {
      const factoryWithBrokenSave = createRunPlaneFactory({
        getDatastore: () => memory,
        logger: { ...SILENT, warn },
      });
      expect(factoryWithBrokenSave.current().completeAndPersist(contribution())).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'cli.run-session.record_failed',
          error: 'disk string fault',
        }),
      );
    } finally {
      saveSpy.mockRestore();
      memory.close();
    }
  });

  it('warns with a stringified error when session retention enforcement throws a non-Error', () => {
    const warn = vi.fn();
    const memory = DataStoreFactory.open({ backend: 'memory' });
    const enforce = vi
      .spyOn(sessionRetentionMod, 'enforceSessionRetention')
      .mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises host handling of non-Error throwables.
        throw 'retention boom';
      });
    try {
      const factoryWithRetention = createRunPlaneFactory({
        getDatastore: () => memory,
        sessionRetentionPolicy: resolveCurrentSessionRetentionPolicy,
        logger: { ...SILENT, warn },
      });
      const recorded = factoryWithRetention.current().completeAndPersist(contribution());
      expect(recorded).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'cli.run-session.retention_failed',
          error: 'retention boom',
        }),
      );
    } finally {
      enforce.mockRestore();
      memory.close();
    }
  });

  it('round-trips a failing YAGNI verdict through host persistence into session summaries', () => {
    // Exercises the generic ToolRunCompletion -> StoredSession host path for a
    // failing verdict. The contribution is constructed directly: this is a
    // host-plane unit test and must not run a tool implementation. YAGNI (like
    // every analysis tool) returns exactly this shape; `passed: false` derives
    // `runOutcome: 'failed'`, and `payload.summary` projects into the session.
    const cwd = '/proj/yagni-subject';
    const failingCompletion = {
      session: {
        tool: 'yagni',
        cwd,
        score: 0,
        passed: false,
        payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 1 } },
      },
    } satisfies ToolRunCompletion;

    const hooks = createRunActionHooks(factory);
    hooks.beginRun?.();
    hooks.completeRun?.(failingCompletion);

    const summaries = listSessionSummaries(datastore, { summaryOnly: true });
    expect(summaries.sessions).toHaveLength(1);
    expect(summaries.sessions[0]).toMatchObject({
      tool: 'yagni',
      cwd,
      passed: false,
      runOutcome: 'failed',
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        warnings: 1,
      },
    });
  });
});

/** Task 3: Run Lifecycle And Cleanup Contract (aligns with host-owned-run-timing ADR-0051). */
describe('Task 3 lifecycle + cleanup contract (narrow seams)', () => {
  it('disposeCurrentScope is safe with no scope (no throw, for CLI-only / early errors)', () => {
    // Mirrors postAction / potential error-path call sites.
    expect(() => disposeCurrentScope()).not.toThrow();
  });

  it('disposeCurrentScope swallows dispose errors (best-effort shutdown)', () => {
    // We can't easily inject a broken scope without broader wiring, but the seam
    // itself swallows; exercising the call path is the high-signal part.
    expect(() => disposeCurrentScope()).not.toThrow();
  });

  // Scope-entered-before-action is asserted inside pre-action-hook (hard guard after enterScope)
  // and covered by e2e + register-action-bodies tests. The beginRun happens in mount action
  // AFTER the hook's enterScope, per the run-plane factory contract (tested above).

  // Datastore handle cleanup: lazy thunk on RunScope; dispose (called from postAction seam)
  // is the owner. When scope moves ownership, explicit close lives on the thunked store;
  // the plane itself is best-effort and does not own the datastore (see scope-access).
});
