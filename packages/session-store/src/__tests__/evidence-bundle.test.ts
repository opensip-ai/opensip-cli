import { logger } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_EVIDENCE_BUNDLE_BYTES,
  MAX_EVIDENCE_BUNDLE_SESSIONS,
  MAX_EVIDENCE_BUNDLE_STEPS,
  commitEvidenceBundle,
  measureEvidenceBundleBytes,
  type EvidenceBundleInput,
} from '../evidence-bundle.js';
import { RunRepo } from '../run-repo.js';
import { runSteps, runs } from '../schema/runs.js';
import { sessionHostMetrics, sessions, sessionToolPayload } from '../schema/sessions.js';
import { SessionRepo } from '../session-repo.js';

import type {
  StoredRun,
  StoredRunStep,
  StoredSession,
  StoredSessionHostMetrics,
} from '@opensip-cli/contracts';
import type { DrizzleDataStore } from '@opensip-cli/datastore/internal';

function makeSession(index = 0, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: `session-${String(index)}`,
    tool: 'fit',
    startedAt: '2026-07-16T12:00:00.000000Z',
    completedAt: '2026-07-16T12:00:00.250000Z',
    cwd: '/proj',
    recipe: 'agent-risk',
    score: 100,
    passed: true,
    runOutcome: 'passed',
    durationMs: 250,
    cliVersion: '0.7.0',
    engineVersion: '1.2.3',
    payload: { __version: 1, summary: { passed: true }, index },
    ...overrides,
  };
}

function makeMetrics(overrides: StoredSessionHostMetrics = {}): StoredSessionHostMetrics {
  return { renderMs: 2, egressMs: 3, totalCommandMs: 300, ...overrides };
}

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: '2026-07-16T12:00:00.000000Z',
    completedAt: '2026-07-16T12:00:01.000000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 1,
      passed: 1,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    cliVersion: '0.7.0',
    ...overrides,
  };
}

function makeStep(index = 0, overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: `step-${String(index)}`,
    runId: 'run-1',
    logicalStepKey: `${String(index)}:fit:fitness`,
    ordinal: index,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    effectiveArgs: { recipe: 'agent-risk' },
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    evidence: { kind: 'signal-envelope', schemaVersion: 2 },
    ...overrides,
  };
}

function sessionEntry(index = 0, overrides: Partial<StoredSession> = {}) {
  return { session: makeSession(index, overrides), hostMetrics: makeMetrics() };
}

function completeInput(overrides: Partial<EvidenceBundleInput> = {}): EvidenceBundleInput {
  return {
    sessions: [sessionEntry()],
    run: {
      run: makeRun(),
      steps: [makeStep(0, { sessionId: 'session-0' })],
    },
    ...overrides,
  };
}

function withMalformedField<T extends object>(base: T, key: string, value: unknown): T {
  return { ...base, [key]: value };
}

let datastore: DrizzleDataStore;

beforeEach(() => {
  datastore = requireDrizzleHandle(DataStoreFactory.open({ backend: 'memory' }));
});

afterEach(() => {
  vi.restoreAllMocks();
  datastore.close();
});

function counts(store = datastore) {
  return {
    sessions: store.db.select().from(sessions).all().length,
    payloads: store.db.select().from(sessionToolPayload).all().length,
    metrics: store.db.select().from(sessionHostMetrics).all().length,
    runs: store.db.select().from(runs).all().length,
    steps: store.db.select().from(runSteps).all().length,
  };
}

function expectNoEvidence(store = datastore): void {
  expect(counts(store)).toEqual({ sessions: 0, payloads: 0, metrics: 0, runs: 0, steps: 0 });
}

describe('commitEvidenceBundle', () => {
  it('accepts an empty bundle as an atomic no-op', () => {
    expect(commitEvidenceBundle(datastore, { sessions: [] })).toMatchObject({
      status: 'committed',
      sessionIds: [],
      sessionCount: 0,
      stepCount: 0,
    });
    expectNoEvidence();
  });

  it('commits a Session-only bundle with payload, lexical timing, and merged host metrics', () => {
    const input: EvidenceBundleInput = {
      sessions: [
        {
          session: makeSession(0),
          hostMetrics: makeMetrics({ persistMs: 7 }),
        },
      ],
    };

    const result = commitEvidenceBundle(datastore, input);

    expect(result).toMatchObject({
      status: 'committed',
      sessionIds: ['session-0'],
      sessionCount: 1,
      stepCount: 0,
    });
    const stored = new SessionRepo(datastore).get('session-0');
    expect(stored).toMatchObject({
      startedAt: '2026-07-16T12:00:00.000000Z',
      completedAt: '2026-07-16T12:00:00.250000Z',
      payload: input.sessions[0]?.session.payload,
      hostMetrics: {
        renderMs: 2,
        egressMs: 3,
        totalCommandMs: 300,
      },
    });
    expect(stored?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(7);
  });

  it('freezes one persistMs delta for every Session independent of insertion order', () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValue(999);

    const result = commitEvidenceBundle(datastore, {
      // Reverse identity order so neither lexical nor insertion position can
      // accidentally become part of the timing result.
      sessions: [sessionEntry(1), sessionEntry(0)],
    });

    expect(result).toMatchObject({ status: 'committed', persistMs: 25 });
    const repo = new SessionRepo(datastore);
    expect(repo.get('session-0')?.hostMetrics?.persistMs).toBe(25);
    expect(repo.get('session-1')?.hostMetrics?.persistMs).toBe(25);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('commits a parent-only bundle and preserves ordered RunSteps', () => {
    const result = commitEvidenceBundle(datastore, {
      sessions: [],
      run: {
        run: makeRun({
          aggregate: {
            steps: 2,
            passed: 2,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
        }),
        steps: [makeStep(0), makeStep(1)],
      },
    });

    expect(result).toMatchObject({
      status: 'committed',
      sessionIds: [],
      runId: 'run-1',
      sessionCount: 0,
      stepCount: 2,
    });
    const repo = new RunRepo(datastore);
    expect(repo.getRun('run-1')).toEqual(
      makeRun({
        aggregate: {
          steps: 2,
          passed: 2,
          failed: 0,
          faulted: 0,
          errors: 0,
          warnings: 0,
        },
      }),
    );
    expect(repo.listStepsForRun('run-1').map((step) => step.id)).toEqual(['step-0', 'step-1']);
  });

  it('retains the legacy empty optional correlation id accepted by RunRepo', () => {
    const run = makeRun({ correlationRunId: '' });

    expect(
      commitEvidenceBundle(datastore, {
        sessions: [],
        run: { run, steps: [] },
      }),
    ).toMatchObject({ status: 'committed', runId: run.id });
    expect(new RunRepo(datastore).getRun(run.id)?.correlationRunId).toBe('');
  });

  it('links one or many in-bundle Sessions and an already-retained Session', () => {
    const sessionRepo = new SessionRepo(datastore);
    sessionRepo.save(makeSession(9, { id: 'retained-session', payload: null }));
    const bundleSessions = [sessionEntry(0), sessionEntry(1)];
    const result = commitEvidenceBundle(datastore, {
      sessions: bundleSessions,
      run: {
        run: makeRun({
          aggregate: {
            steps: 3,
            passed: 3,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
        }),
        steps: [
          makeStep(0, { sessionId: 'session-0' }),
          makeStep(1, { sessionId: 'session-1' }),
          makeStep(2, { sessionId: 'retained-session' }),
        ],
      },
    });

    expect(result.status).toBe('committed');
    expect(new RunRepo(datastore).listStepsForRun('run-1').map((step) => step.sessionId)).toEqual([
      'session-0',
      'session-1',
      'retained-session',
    ]);
  });

  it('evaluates a rejecting precondition under the write lock and transaction', () => {
    const originalLock = datastore.withWriteLock.bind(datastore);
    const originalTransaction = datastore.transaction.bind(datastore);
    let lockHeld = false;
    let transactionHeld = false;
    vi.spyOn(datastore, 'withWriteLock').mockImplementation((operation, fn) =>
      originalLock(operation, () => {
        lockHeld = true;
        try {
          return fn();
        } finally {
          lockHeld = false;
        }
      }),
    );
    vi.spyOn(datastore, 'transaction').mockImplementation((fn) =>
      originalTransaction((tx) => {
        transactionHeld = true;
        try {
          return fn(tx);
        } finally {
          transactionHeld = false;
        }
      }),
    );
    const precondition = vi.fn(() => {
      expect(lockHeld).toBe(true);
      expect(transactionHeld).toBe(true);
      return false;
    });

    expect(commitEvidenceBundle(datastore, { ...completeInput(), precondition })).toEqual({
      status: 'precondition-rejected',
    });
    expect(precondition).toHaveBeenCalledOnce();
    expectNoEvidence();
  });

  it('rejects duplicate identities and Session links pinned unique by the RunStep index', () => {
    const duplicateIdentity = commitEvidenceBundle(datastore, {
      sessions: [sessionEntry(0), sessionEntry(1, { id: 'session-0' })],
    });
    expect(duplicateIdentity).toEqual({ status: 'failed', reason: 'duplicate-id' });
    expectNoEvidence();

    // `run_steps_session_id_unique_idx` permits at most one RunStep per linked
    // Session. Prevalidation mirrors that schema invariant before transaction.
    const duplicateLink = commitEvidenceBundle(datastore, {
      sessions: [sessionEntry(0)],
      run: {
        run: makeRun({
          aggregate: {
            steps: 2,
            passed: 2,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
        }),
        steps: [makeStep(0, { sessionId: 'session-0' }), makeStep(1, { sessionId: 'session-0' })],
      },
    });
    expect(duplicateLink).toEqual({ status: 'failed', reason: 'duplicate-id' });
    expectNoEvidence();
  });

  it('rejects missing retained Session links without committing a prefix', () => {
    const result = commitEvidenceBundle(datastore, {
      ...completeInput(),
      run: {
        run: makeRun(),
        steps: [makeStep(0, { sessionId: 'missing-session' })],
      },
    });

    expect(result).toEqual({ status: 'failed', reason: 'missing-session-link' });
    expectNoEvidence();
  });

  it('accepts exact Session/step count bounds and rejects one over either bound', () => {
    const exactSessions = Array.from({ length: MAX_EVIDENCE_BUNDLE_SESSIONS }, (_value, index) =>
      sessionEntry(index, { payload: undefined }),
    );
    const exactSteps = Array.from({ length: MAX_EVIDENCE_BUNDLE_STEPS }, (_value, index) =>
      makeStep(index),
    );
    const exact = commitEvidenceBundle(datastore, {
      sessions: exactSessions,
      run: {
        run: makeRun({
          aggregate: {
            steps: MAX_EVIDENCE_BUNDLE_STEPS,
            passed: MAX_EVIDENCE_BUNDLE_STEPS,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
        }),
        steps: exactSteps,
      },
    });
    expect(exact).toMatchObject({
      status: 'committed',
      sessionCount: MAX_EVIDENCE_BUNDLE_SESSIONS,
      stepCount: MAX_EVIDENCE_BUNDLE_STEPS,
    });

    const sessionOverStore = requireDrizzleHandle(DataStoreFactory.open({ backend: 'memory' }));
    const stepOverStore = requireDrizzleHandle(DataStoreFactory.open({ backend: 'memory' }));
    try {
      expect(
        commitEvidenceBundle(sessionOverStore, {
          sessions: Array.from({ length: MAX_EVIDENCE_BUNDLE_SESSIONS + 1 }, (_value, index) =>
            sessionEntry(index, { payload: undefined }),
          ),
        }),
      ).toEqual({ status: 'failed', reason: 'limit-exceeded' });
      expectNoEvidence(sessionOverStore);

      expect(
        commitEvidenceBundle(stepOverStore, {
          sessions: [],
          run: {
            run: makeRun(),
            steps: Array.from({ length: MAX_EVIDENCE_BUNDLE_STEPS + 1 }, (_value, index) =>
              makeStep(index),
            ),
          },
        }),
      ).toEqual({ status: 'failed', reason: 'limit-exceeded' });
      expectNoEvidence(stepOverStore);
    } finally {
      sessionOverStore.close();
      stepOverStore.close();
    }
  });

  it('accepts the exact canonical byte ceiling and rejects one byte over', () => {
    const seed = completeInput({
      sessions: [sessionEntry(0, { payload: { __version: 1, data: '' } })],
      run: undefined,
    });
    const baseBytes = measureEvidenceBundleBytes(seed);
    const exactInput = completeInput({
      sessions: [
        sessionEntry(0, {
          payload: { __version: 1, data: 'x'.repeat(MAX_EVIDENCE_BUNDLE_BYTES - baseBytes) },
        }),
      ],
      run: undefined,
    });
    expect(measureEvidenceBundleBytes(exactInput)).toBe(MAX_EVIDENCE_BUNDLE_BYTES);
    expect(commitEvidenceBundle(datastore, exactInput).status).toBe('committed');

    const overStore = requireDrizzleHandle(DataStoreFactory.open({ backend: 'memory' }));
    try {
      const overInput = completeInput({
        sessions: [
          sessionEntry(0, {
            payload: {
              __version: 1,
              data: 'x'.repeat(MAX_EVIDENCE_BUNDLE_BYTES - baseBytes + 1),
            },
          }),
        ],
        run: undefined,
      });
      expect(measureEvidenceBundleBytes(overInput)).toBe(MAX_EVIDENCE_BUNDLE_BYTES + 1);
      expect(commitEvidenceBundle(overStore, overInput)).toEqual({
        status: 'failed',
        reason: 'limit-exceeded',
      });
      expectNoEvidence(overStore);
    } finally {
      overStore.close();
    }
  });

  it.each([
    ['sessions', 'sessions'],
    ['session_tool_payload', 'session_tool_payload'],
    ['runs', 'runs'],
    ['run_steps', 'run_steps'],
    ['session_host_metrics', 'session_host_metrics'],
  ] as const)('rolls back the whole bundle when the %s insert fails', (_stage, table) => {
    datastore.db.run(
      sql.raw(
        `CREATE TRIGGER evidence_bundle_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END`,
      ),
    );

    expect(commitEvidenceBundle(datastore, completeInput())).toEqual({
      status: 'failed',
      reason: 'write-failed',
    });
    expectNoEvidence();
  });

  it('rolls back when a precondition throws and does not expose the thrown detail', () => {
    const result = commitEvidenceBundle(datastore, {
      ...completeInput(),
      precondition: () => {
        throw new Error('/private/project/datastore.sqlite SQL secret');
      },
    });
    expect(result).toEqual({ status: 'failed', reason: 'write-failed' });
    expect(JSON.stringify(result)).not.toContain('private');
    expectNoEvidence();
  });

  it('rejects non-serializable payloads and malformed metrics before the write lock', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const lock = vi.spyOn(datastore, 'withWriteLock');

    expect(
      commitEvidenceBundle(datastore, {
        sessions: [sessionEntry(0, { payload: circular })],
      }),
    ).toEqual({ status: 'failed', reason: 'invalid-input' });
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [
          {
            session: makeSession(),
            hostMetrics: { persistMs: -1 },
          },
        ],
      }),
    ).toEqual({ status: 'failed', reason: 'invalid-input' });
    expect(lock).not.toHaveBeenCalled();
    expectNoEvidence();
  });

  it('rejects every malformed required mapped row before lock or precondition entry', () => {
    const lock = vi.spyOn(datastore, 'withWriteLock');
    const preconditions: ReturnType<typeof vi.fn<() => boolean>>[] = [];
    const precondition = (): ReturnType<typeof vi.fn<() => boolean>> => {
      const guard = vi.fn(() => false);
      preconditions.push(guard);
      return guard;
    };
    const invalidSessions: readonly StoredSession[] = [
      withMalformedField(makeSession(), 'id', undefined),
      withMalformedField(makeSession(), 'tool', 7),
      withMalformedField(makeSession(), 'startedAt', 7),
      withMalformedField(makeSession(), 'completedAt', null),
      withMalformedField(makeSession(), 'cwd', {}),
      withMalformedField(makeSession(), 'score', Number.NaN),
      withMalformedField(makeSession(), 'passed', 'true'),
      withMalformedField(makeSession(), 'durationMs', -1),
      withMalformedField(makeSession(), 'runOutcome', 'invented'),
    ];
    for (const session of invalidSessions) {
      expect(
        commitEvidenceBundle(datastore, {
          sessions: [{ session, hostMetrics: {} }],
          precondition: precondition(),
        }),
      ).toEqual({ status: 'failed', reason: 'invalid-input' });
    }

    const invalidRuns: readonly StoredRun[] = [
      withMalformedField(makeRun(), 'id', ''),
      withMalformedField(makeRun(), 'name', 1),
      withMalformedField(makeRun(), 'source', 'invented'),
      withMalformedField(makeRun(), 'cwd', null),
      withMalformedField(makeRun(), 'startedAt', 1),
      withMalformedField(makeRun(), 'completedAt', {}),
      withMalformedField(makeRun(), 'durationMs', -1),
      withMalformedField(makeRun(), 'exitCode', 0.5),
      withMalformedField(makeRun(), 'aggregate', {
        steps: 1,
        passed: 1,
        failed: 0,
        faulted: 0,
        errors: 0,
      }),
      withMalformedField(makeRun(), 'aggregate', {
        steps: -1,
        passed: 1,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      }),
    ];
    for (const run of invalidRuns) {
      expect(
        commitEvidenceBundle(datastore, {
          sessions: [],
          run: { run, steps: [] },
          precondition: precondition(),
        }),
      ).toEqual({ status: 'failed', reason: 'invalid-input' });
    }

    const invalidSteps: readonly StoredRunStep[] = [
      withMalformedField(makeStep(), 'id', undefined),
      withMalformedField(makeStep(), 'runId', 1),
      withMalformedField(makeStep(), 'logicalStepKey', null),
      withMalformedField(makeStep(), 'ordinal', 0.5),
      withMalformedField(makeStep(), 'attempt', '1'),
      withMalformedField(makeStep(), 'tool', null),
      withMalformedField(makeStep(), 'command', 2),
      withMalformedField(makeStep(), 'stableId', ''),
      withMalformedField(makeStep(), 'exitCode', 0.5),
      withMalformedField(makeStep(), 'outcome', 'invented'),
      withMalformedField(makeStep(), 'durationMs', -1),
    ];
    for (const step of invalidSteps) {
      expect(
        commitEvidenceBundle(datastore, {
          sessions: [],
          run: { run: makeRun(), steps: [step] },
          precondition: precondition(),
        }),
      ).toEqual({ status: 'failed', reason: 'invalid-input' });
    }

    expect(lock).not.toHaveBeenCalled();
    for (const guard of preconditions) expect(guard).not.toHaveBeenCalled();
    expectNoEvidence();
  });

  it('keeps hostile preparation and post-commit diagnostics inside the closed result API', () => {
    const lock = vi.spyOn(datastore, 'withWriteLock');
    const hostileInput: EvidenceBundleInput = new Proxy(
      { sessions: [] },
      {
        get() {
          throw new Error('/private/preparation/path');
        },
      },
    );
    expect(commitEvidenceBundle(datastore, hostileInput)).toEqual({
      status: 'failed',
      reason: 'invalid-input',
    });
    expect(lock).not.toHaveBeenCalled();

    vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('diagnostics failed after commit');
    });
    const committed = commitEvidenceBundle(datastore, {
      sessions: [sessionEntry(0)],
    });
    expect(committed.status).toBe('committed');
    expect(new SessionRepo(datastore).get('session-0')).not.toBeNull();
  });
});

describe('legacy repository and bundle parity', () => {
  it('emits the same missing-payload-version diagnostic after either write path commits', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const repo = new SessionRepo(datastore);
    repo.save(
      makeSession(0, {
        id: 'legacy-unversioned',
        payload: { summary: { passed: true } },
      }),
    );
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [
          sessionEntry(1, {
            id: 'bundle-unversioned',
            payload: { summary: { passed: true } },
          }),
        ],
      }).status,
    ).toBe('committed');

    const diagnosticIds = warn.mock.calls.flatMap(([entry]) =>
      typeof entry === 'object' &&
      entry !== null &&
      entry.evt === 'session.payload.missing_version' &&
      typeof entry.sessionId === 'string'
        ? [entry.sessionId]
        : [],
    );
    expect(diagnosticIds).toEqual(['legacy-unversioned', 'bundle-unversioned']);
  });

  it('shares Session mapping, null-payload semantics, payload version, and host metrics', () => {
    const legacySession = makeSession(0, {
      id: 'legacy-session',
      payload: { __version: 1, nested: { value: true } },
    });
    const bundleSession = { ...legacySession, id: 'bundle-session' };
    const repo = new SessionRepo(datastore);
    repo.save(legacySession);
    repo.upsertHostMetrics(legacySession.id, makeMetrics({ persistMs: 5 }));
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [
          {
            session: bundleSession,
            hostMetrics: makeMetrics({ persistMs: 5 }),
          },
        ],
      }).status,
    ).toBe('committed');

    const [legacyRow, bundleRow] = [legacySession.id, bundleSession.id].map((id) =>
      datastore.db
        .select()
        .from(sessions)
        .where(sql`${sessions.id} = ${id}`)
        .get(),
    );
    expect({ ...bundleRow, id: legacyRow?.id }).toEqual(legacyRow);
    const [legacyPayload, bundlePayload] = [legacySession.id, bundleSession.id].map((id) =>
      datastore.db
        .select()
        .from(sessionToolPayload)
        .where(sql`${sessionToolPayload.sessionId} = ${id}`)
        .get(),
    );
    expect({
      ...bundlePayload,
      sessionId: legacyPayload?.sessionId,
    }).toEqual(legacyPayload);
    expect(bundlePayload?.payload_version).toBe(1);
    expect(repo.get(bundleSession.id)?.hostMetrics).toMatchObject(makeMetrics());
    expect(repo.get(bundleSession.id)?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(5);

    repo.save(makeSession(2, { id: 'legacy-null', payload: null }));
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [sessionEntry(3, { id: 'bundle-null', payload: null })],
      }).status,
    ).toBe('committed');
    expect(
      datastore.db
        .select()
        .from(sessionToolPayload)
        .where(sql`${sessionToolPayload.sessionId} IN ('legacy-null', 'bundle-null')`)
        .all(),
    ).toEqual([]);
  });

  it('shares Run/step validation and row mapping with RunRepo', () => {
    const repo = new RunRepo(datastore);
    const legacyRun = makeRun({ id: 'legacy-run' });
    const legacyStep = makeStep(0, { id: 'legacy-step', runId: legacyRun.id });
    repo.saveRunWithSteps(legacyRun, [legacyStep]);

    const bundleRun = { ...legacyRun, id: 'bundle-run' };
    const bundleStep = { ...legacyStep, id: 'bundle-step', runId: bundleRun.id };
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [],
        run: { run: bundleRun, steps: [bundleStep] },
      }).status,
    ).toBe('committed');
    expect({ ...repo.getRun(bundleRun.id), id: legacyRun.id }).toEqual(repo.getRun(legacyRun.id));
    expect({
      ...repo.listStepsForRun(bundleRun.id)[0],
      id: legacyStep.id,
      runId: legacyRun.id,
    }).toEqual(legacyStep);

    expect(() =>
      repo.saveRunWithSteps(makeRun({ id: 'invalid-legacy' }), [
        makeStep(0, { runId: 'wrong-run' }),
      ]),
    ).toThrow(/mismatched runId/u);
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [],
        run: {
          run: makeRun({ id: 'invalid-bundle' }),
          steps: [makeStep(0, { id: 'invalid-step', runId: 'wrong-run' })],
        },
      }),
    ).toEqual({ status: 'failed', reason: 'invalid-input' });
  });

  it('shares Session timing validation without writing an invalid row', () => {
    const invalid = makeSession(0, {
      id: 'invalid-session',
      startedAt: 'not-a-date',
      completedAt: 'also-not-a-date',
    });
    expect(() => new SessionRepo(datastore).save(invalid)).toThrow(/Invalid session timing/u);
    expect(
      commitEvidenceBundle(datastore, {
        sessions: [{ session: invalid, hostMetrics: {} }],
      }),
    ).toEqual({ status: 'failed', reason: 'invalid-input' });
    expectNoEvidence();
  });

  it('rejects malformed legacy Session/Run/RunStep rows before lock or precondition', () => {
    const lock = vi.spyOn(datastore, 'withWriteLock');
    const sessionRepo = new SessionRepo(datastore);
    expect(() => sessionRepo.save(withMalformedField(makeSession(), 'passed', 'true'))).toThrow(
      /Invalid required Session row shape/u,
    );

    const runRepo = new RunRepo(datastore);
    const runPrecondition = vi.fn(() => true);
    expect(() =>
      runRepo.saveRunWithStepsIf(
        withMalformedField(makeRun(), 'aggregate', { steps: 1 }),
        [],
        runPrecondition,
      ),
    ).toThrow(/Invalid required Run row shape/u);
    const stepPrecondition = vi.fn(() => true);
    expect(() =>
      runRepo.saveRunWithStepsIf(
        makeRun(),
        [withMalformedField(makeStep(), 'stableId', '')],
        stepPrecondition,
      ),
    ).toThrow(/Invalid required RunStep row shape/u);

    expect(lock).not.toHaveBeenCalled();
    expect(runPrecondition).not.toHaveBeenCalled();
    expect(stepPrecondition).not.toHaveBeenCalled();
    expectNoEvidence();
  });
});
