/**
 * `SessionResultsReadPort` against a REAL in-memory `DataStore` (Task 6.1 step 5,
 * 7 — result-first behavior; replay only, never re-run).
 *
 * Sessions are seeded via `SessionRepo` (test files may import it; production MCP
 * source never names it). The per-tool replay is injected as a deterministic
 * fake `replayFor` — so the test exercises the port's filter mapping
 * (severity → `errors-only`/`warnings-only`, limit → `top:N`) and provenance
 * without depending on a specific tool's replay internals. The fake replay also
 * proves the port REPLAYS a stored session — it never invokes a run command.
 */

import {
  type AgentHostSupport,
  assembleAgentCatalog,
  type StoredRun,
  type StoredRunStep,
  buildSignalEnvelope,
  type ToolSessionReplay,
  type CommandResult,
  type StoredSession,
} from '@opensip-cli/contracts';
import {
  BASELINE_FORMAT_VERSION,
  createSignal,
  HOST_VERDICT_POLICY_FALLBACK,
  ToolRegistry,
  type BaselineIdentityMetadata,
  type Signal,
  type ToolShortId,
} from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { RunRepo, SessionRepo, type SessionReplayFn } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionResultsReadPort } from '../session-results-read-port.js';

/** Local test fixture — not a runtime export. */
const DEFAULT_TEST_BASELINE_IDENTITY: BaselineIdentityMetadata = {
  baselineFormatVersion: BASELINE_FORMAT_VERSION,
  fingerprintStrategyId: 'opensip.default.rule-file-line-col',
  fingerprintStrategyVersion: 1,
};

let store: DataStore;
let replayCalls: ToolShortId[];

beforeEach(() => {
  store = DataStoreFactory.open({ backend: 'memory' });
  replayCalls = [];
});

afterEach(() => {
  store.close();
});

function makeSession(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'fit-1',
    tool: 'fit',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:30.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 80,
    passed: false,
    durationMs: 30_000,
    payload: { summary: { total: 2, passed: 0, failed: 2, errors: 1, warnings: 1 } },
    ...over,
  };
}

function makeRun(over: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run-ledger-1',
    name: 'fit',
    source: 'implicit-tool',
    cwd: '/proj',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:30.000Z',
    durationMs: 30_000,
    exitCode: 1,
    aggregate: { steps: 1, passed: 0, failed: 1, faulted: 0, errors: 1, warnings: 1 },
    ...over,
  };
}

function makeStep(over: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-ledger-1',
    runId: 'run-ledger-1',
    logicalStepKey: '0:fit:fit',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fit',
    stableId: 'fit',
    exitCode: 1,
    outcome: 'failed',
    durationMs: 30_000,
    sessionId: 'fit-1',
    ...over,
  };
}

/** A replay envelope with one error-rung + one warning-rung signal. */
function replayEnvelope(tool: ToolShortId): ToolSessionReplay<CommandResult> {
  const signals: Signal[] = [
    createSignal({ source: 'u', severity: 'high', ruleId: 'err-rule', message: 'an error' }),
    createSignal({ source: 'u', severity: 'medium', ruleId: 'warn-rule', message: 'a warning' }),
  ];
  const envelope = buildSignalEnvelope({
    tool,
    runId: 'r',
    createdAt: '2026-05-21T12:00:00.000Z',
    units: [{ slug: 'u', passed: false, durationMs: 1 }],
    signals,
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
  return { result: {} as CommandResult, envelope, fidelity: 'projection' };
}

function replayEnvelopeWithSignals(
  tool: ToolShortId,
  signals: readonly Signal[],
): ToolSessionReplay<CommandResult> {
  const envelope = buildSignalEnvelope({
    tool,
    runId: `${tool}-run`,
    createdAt: '2026-05-21T12:00:00.000Z',
    units: [{ slug: 'u', passed: signals.length === 0, durationMs: 1 }],
    signals,
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
  return { result: {} as CommandResult, envelope, fidelity: 'projection' };
}

function signal(over: {
  readonly ruleId: string;
  readonly message?: string;
  readonly filePath?: string;
  readonly fingerprint?: string;
  readonly baselineState?: 'added' | 'unchanged';
  readonly severity?: Signal['severity'];
  readonly metadata?: Record<string, unknown>;
}): Signal {
  const metadata: Record<string, unknown> = {};
  if (over.baselineState !== undefined) metadata.baselineState = over.baselineState;
  Object.assign(metadata, over.metadata);
  const base = createSignal({
    source: 'u',
    severity: over.severity ?? 'high',
    ruleId: over.ruleId,
    message: over.message ?? over.ruleId,
    code: { file: over.filePath ?? 'src/a.ts', line: 1, column: 0 },
    metadata,
  });
  return {
    ...base,
    ...(over.fingerprint === undefined ? {} : { fingerprint: over.fingerprint }),
  };
}

function replayReviewSuiteStep(stored: StoredSession): ToolSessionReplay<CommandResult> {
  replayCalls.push(stored.tool);
  return replayEnvelopeWithSignals(stored.tool, [
    signal({
      ruleId: `${stored.tool}-rule`,
      filePath: stored.tool === 'fit' ? 'src/a.ts' : 'src/b.ts',
      fingerprint: `${stored.tool}-fp`,
      baselineState: stored.tool === 'fit' ? 'added' : 'unchanged',
      metadata: { qualifiedName: 'src/review.ts#reviewChange' },
    }),
  ]);
}

const reviewSuiteResolver: (tool: ToolShortId) => SessionReplayFn | undefined = () =>
  replayReviewSuiteStep;

function replayCorruptPayload(_stored: StoredSession): never {
  throw new Error('corrupt payload');
}

const corruptPayloadResolver: (tool: ToolShortId) => SessionReplayFn | undefined = () =>
  replayCorruptPayload;

function compareBaselineSignals(): readonly [Signal, Signal, Signal, Signal] {
  return [
    signal({ ruleId: 'same', fingerprint: 'fp-same' }),
    signal({ ruleId: 'same-duplicate', fingerprint: 'fp-same' }),
    signal({ ruleId: 'new', fingerprint: 'fp-new' }),
    signal({ ruleId: 'missing-fp' }),
  ];
}

function replayCompareBaseline(stored: StoredSession): ToolSessionReplay<CommandResult> {
  replayCalls.push(stored.tool);
  const replay = replayEnvelopeWithSignals(stored.tool, compareBaselineSignals());
  return {
    ...replay,
    envelope: {
      ...replay.envelope,
      signals: replay.envelope.signals.map((replayed) =>
        replayed.ruleId === 'missing-fp' ? { ...replayed, fingerprint: '' } : replayed,
      ),
    },
  };
}

const compareBaselineResolver: (tool: ToolShortId) => SessionReplayFn | undefined = () =>
  replayCompareBaseline;

function replayNewFinding(stored: StoredSession): ToolSessionReplay<CommandResult> {
  return replayEnvelopeWithSignals(stored.tool, [signal({ ruleId: 'new', fingerprint: 'fp-new' })]);
}

const newFindingResolver: (tool: ToolShortId) => SessionReplayFn | undefined = () =>
  replayNewFinding;

/** Records every replayed tool (proving "no re-run") then returns its envelope. */
const replayAndRecord: SessionReplayFn = (stored) => {
  replayCalls.push(stored.tool);
  return replayEnvelope(stored.tool);
};

/** A replay resolver that records every tool it replays (proving "no re-run"). */
const recordingResolver: (tool: ToolShortId) => SessionReplayFn | undefined = () => replayAndRecord;

/**
 * A minimal already-assembled catalog for the replay-focused tests. Plan 03
 * makes the assembled catalog a required construction dep; the catalog content
 * is exercised in the dedicated `agentCatalog` describe below, so these tests
 * inject this bare fixture and focus on session replay.
 */
const AGENT_CATALOG = assembleAgentCatalog({ rootCommands: [], suiteNames: [] });

function port(): SessionResultsReadPort {
  return new SessionResultsReadPort({
    store,
    replayFor: recordingResolver,
    agentCatalog: AGENT_CATALOG,
  });
}

function registryWithCanonicalFitnessName(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
    metadata: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'fitness',
      version: '1.0.0',
      description: 'fitness fixture',
    },
    commandSpecs: [],
  });
  return tools;
}

describe('SessionResultsReadPort — canonical execution Runs', () => {
  it('lists bounded parent Runs newest-first with the exact CLI history DTO', () => {
    const repo = new RunRepo(store);
    repo.saveRun(makeRun({ id: 'run-old', completedAt: '2026-05-20T12:00:30.000Z' }));
    repo.saveRun(makeRun({ id: 'run-new', completedAt: '2026-05-22T12:00:30.000Z' }));

    const out = port().listExecutionRuns({ limit: 1 });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({
      type: 'run-history',
      runs: [
        {
          run: expect.objectContaining({ id: 'run-new' }),
          showCommand: 'opensip runs show run-new --json',
        },
      ],
      requestedLimit: 1,
      effectiveLimit: 1,
      truncated: true,
    });
    expect(replayCalls).toEqual([]);
  });

  it('returns one exact parent with deterministic pagination and Session references only', () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-linked' }));
    const run = makeRun({
      id: 'run-detail',
      name: 'audit',
      source: 'built-in-suite',
      aggregate: { steps: 3, passed: 2, failed: 1, faulted: 0, errors: 1, warnings: 1 },
    });
    new RunRepo(store).saveRunWithSteps(run, [
      makeStep({
        id: 'step-later-attempt',
        runId: run.id,
        ordinal: 0,
        attempt: 2,
        sessionId: undefined,
      }),
      makeStep({
        id: 'step-linked',
        runId: run.id,
        ordinal: 0,
        attempt: 1,
        sessionId: 'fit-linked',
      }),
      makeStep({
        id: 'step-run-only',
        runId: run.id,
        ordinal: 1,
        attempt: 1,
        sessionId: undefined,
      }),
    ]);

    const out = port().showExecutionRun({ runId: run.id, offset: 0, limit: 2 });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.type).toBe('run-detail');
    expect(out.value.run).toEqual(run);
    expect(out.value.steps.map((step) => step.id)).toEqual(['step-linked', 'step-later-attempt']);
    expect(out.value).toMatchObject({
      offset: 0,
      limit: 2,
      total: 3,
      nextOffset: 2,
      sessionFollowUps: [
        {
          runStepId: 'step-linked',
          sessionId: 'fit-linked',
          showCommand: 'opensip sessions show fit-linked --json',
        },
      ],
    });
    expect(out.value).not.toHaveProperty('sessions');
    expect(out.value).not.toHaveProperty('payload');
    expect(out.value).not.toHaveProperty('envelope');
    expect(replayCalls).toEqual([]);
  });

  it('uses exact parent identity only and keeps legacy Session replay semantics unchanged', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-session', tool: 'fit' }));
    new RunRepo(store).saveRunWithSteps(makeRun({ id: 'run-exact', name: 'audit' }), [
      makeStep({ id: 'step-exact', runId: 'run-exact', sessionId: 'fit-session' }),
    ]);

    const results = port();
    const parents = results.listExecutionRuns();
    const sessions = results.listRuns();
    const bySessionId = results.showExecutionRun({ runId: 'fit-session' });
    const byName = results.showExecutionRun({ runId: 'audit' });
    const byLatest = results.showExecutionRun({ runId: 'latest' });
    const legacyLatest = await results.showRun({ ref: 'latest', tool: 'fit' });

    expect(parents.ok && parents.value.runs.map((entry) => entry.run.id)).toEqual(['run-exact']);
    expect(sessions.ok && sessions.value.map((entry) => entry.id)).toEqual(['fit-session']);
    for (const missing of [bySessionId, byName, byLatest]) {
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('not-found');
    }
    expect(legacyLatest.ok).toBe(true);
    expect(replayCalls).toEqual(['fit']);
  });

  it('maps malformed identities and bounds to fixed safe invalid-argument errors', () => {
    const results = port();
    const outcomes = [
      results.listExecutionRuns({ limit: 0 }),
      results.showExecutionRun({ runId: '../unsafe' }),
      results.showExecutionRun({ runId: 'run-safe', offset: -1 }),
      results.showExecutionRun({ runId: 'run-safe', limit: 501 }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toEqual({
          code: 'invalid-argument',
          message: 'Execution Run identity or pagination bounds are invalid.',
        });
      }
    }
  });

  it('rejects an unsafe retained Session id without interpolating it into a command or error', () => {
    const unsafeId = 'unsafe/session';
    new SessionRepo(store).save(makeSession({ id: unsafeId }));
    new RunRepo(store).saveRunWithSteps(makeRun({ id: 'run-unsafe-link' }), [
      makeStep({ id: 'step-unsafe-link', runId: 'run-unsafe-link', sessionId: unsafeId }),
    ]);

    const out = port().showExecutionRun({ runId: 'run-unsafe-link' });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toEqual({
        code: 'execution-run-read-failed',
        message: 'Stored execution Run evidence could not be read.',
      });
      expect(out.error.message).not.toContain(unsafeId);
    }
    expect(replayCalls).toEqual([]);
  });

  it('reads only the injected cache/project store with no cross-store fallback', () => {
    const otherStore = DataStoreFactory.open({ backend: 'memory' });
    try {
      new RunRepo(store).saveRun(makeRun({ id: 'run-project' }));
      new RunRepo(otherStore).saveRun(makeRun({ id: 'run-cache' }));
      const projectPort = port();
      const cachePort = new SessionResultsReadPort({
        store: otherStore,
        replayFor: recordingResolver,
        agentCatalog: AGENT_CATALOG,
      });

      const projectRuns = projectPort.listExecutionRuns();
      const cacheRuns = cachePort.listExecutionRuns();

      expect(projectRuns.ok && projectRuns.value.runs.map((entry) => entry.run.id)).toEqual([
        'run-project',
      ]);
      expect(cacheRuns.ok && cacheRuns.value.runs.map((entry) => entry.run.id)).toEqual([
        'run-cache',
      ]);
      expect(projectPort.showExecutionRun({ runId: 'run-cache' }).ok).toBe(false);
      expect(cachePort.showExecutionRun({ runId: 'run-project' }).ok).toBe(false);
    } finally {
      otherStore.close();
    }
  });

  it('filters contaminated parent history by project cwd before applying its limit', () => {
    const repo = new RunRepo(store);
    repo.saveRun(
      makeRun({ id: 'run-local-old', cwd: '/proj', completedAt: '2026-05-20T12:00:30.000Z' }),
    );
    repo.saveRun(
      makeRun({ id: 'run-foreign-new', cwd: '/foreign', completedAt: '2026-05-22T12:00:30.000Z' }),
    );
    const scoped = new SessionResultsReadPort({
      store,
      projectRoot: '/proj',
      replayFor: recordingResolver,
      agentCatalog: AGENT_CATALOG,
    });

    const history = scoped.listExecutionRuns({ limit: 1 });

    expect(history.ok && history.value.runs.map((entry) => entry.run.id)).toEqual([
      'run-local-old',
    ]);
    expect(history.ok && history.value.truncated).toBe(false);
    const foreign = scoped.showExecutionRun({ runId: 'run-foreign-new' });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('not-found');
  });

  it('returns a coherent immutable snapshot even when retention later deletes its parent', () => {
    const repo = new RunRepo(store);
    const oldRun = makeRun({ id: 'run-snapshot', completedAt: '2026-05-20T12:00:30.000Z' });
    repo.saveRunWithSteps(oldRun, [
      makeStep({ id: 'step-snapshot', runId: oldRun.id, sessionId: undefined }),
    ]);
    const beforeRetention = port().showExecutionRun({ runId: oldRun.id });
    expect(beforeRetention.ok).toBe(true);

    repo.saveRun(makeRun({ id: 'run-retained', completedAt: '2026-05-22T12:00:30.000Z' }));
    expect(repo.pruneToCountBatch(1).deleted).toBe(1);
    expect(repo.getRun(oldRun.id)).toBeNull();

    expect(beforeRetention.ok).toBe(true);
    if (beforeRetention.ok) {
      expect(beforeRetention.value.run.id).toBe(oldRun.id);
      expect(beforeRetention.value.steps.map((step) => step.id)).toEqual(['step-snapshot']);
      expect(Object.isFrozen(beforeRetention.value.run)).toBe(true);
      expect(Object.isFrozen(beforeRetention.value.steps)).toBe(true);
    }
  });
});

describe('SessionResultsReadPort — listRuns', () => {
  it('lists stored runs as lean RunSummary pointers (newest first)', () => {
    new SessionRepo(store).save(
      makeSession({
        id: 'a',
        startedAt: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    new SessionRepo(store).save(
      makeSession({
        id: 'b',
        startedAt: '2026-05-02T00:00:00.000Z',
        completedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    const out = port().listRuns();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.map((r) => r.id)).toEqual(['b', 'a']);
      expect(out.value[0]?.showCommand).toContain('opensip sessions show');
    }
  });

  it('honors the tool filter', () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-x', tool: 'fit' }));
    new SessionRepo(store).save(makeSession({ id: 'graph-x', tool: 'graph' }));
    const out = port().listRuns({ tool: 'graph' });
    expect(out.ok && out.value.map((r) => r.id)).toEqual(['graph-x']);
  });

  it('carries cli/engine version provenance into the RunSummary', () => {
    new SessionRepo(store).save(
      makeSession({ id: 'ver-x', cliVersion: '0.4.0', engineVersion: '0.4.0' }),
    );
    const out = port().listRuns();
    const summary = out.ok ? out.value.find((r) => r.id === 'ver-x') : undefined;
    expect(summary?.cliVersion).toBe('0.4.0');
    expect(summary?.engineVersion).toBe('0.4.0');
  });

  it('carries ledger step references into RunSummary rows', () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-1' }));
    new RunRepo(store).saveRunWithSteps(makeRun(), [makeStep()]);

    const out = port().listRuns();

    const summary = out.ok ? out.value.find((r) => r.id === 'fit-1') : undefined;
    expect(summary?.ledger).toEqual({
      runId: 'run-ledger-1',
      stepId: 'step-ledger-1',
      logicalStepKey: '0:fit:fit',
      ordinal: 0,
      attempt: 1,
    });
  });

  it('preserves stored layout identity across list_runs → show_run', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-layout', tool: 'fit' }));
    const results = new SessionResultsReadPort({
      store,
      tools: registryWithCanonicalFitnessName(),
      replayFor: recordingResolver,
      agentCatalog: AGENT_CATALOG,
    });

    const listed = results.listRuns();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const pointer = listed.value.find((run) => run.id === 'fit-layout');
    expect(pointer?.tool).toBe('fit');

    const shown = await results.showRun({ ref: pointer?.id ?? '' });
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.value.session?.tool).toBe(pointer?.tool);
      expect(shown.value.data.envelope.tool).toBe(pointer?.tool);
    }
  });
});

describe('SessionResultsReadPort — latestFindings (severity/limit → replay filters)', () => {
  beforeEach(() => {
    new SessionRepo(store).save(makeSession());
  });

  it('maps severity:errors → errors-only and returns only error-rung findings', async () => {
    const out = await port().latestFindings({ tool: 'fit', severity: 'errors' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.filtersApplied).toContain('errors-only');
      expect(out.value.data.map((f) => f.ruleId)).toEqual(['err-rule']);
    }
    // It REPLAYED the persisted fit session — it never ran the tool.
    expect(replayCalls).toEqual(['fit']);
  });

  it('maps severity:warnings → warnings-only', async () => {
    const out = await port().latestFindings({ tool: 'fit', severity: 'warnings' });
    expect(out.ok && out.value.filtersApplied).toContain('warnings-only');
    expect(out.ok && out.value.data.map((f) => f.ruleId)).toEqual(['warn-rule']);
  });

  it('maps limit → top:N', async () => {
    const out = await port().latestFindings({ tool: 'fit', limit: 1 });
    expect(out.ok && out.value.filtersApplied).toContain('top:1');
    expect(out.ok && out.value.data).toHaveLength(1);
  });

  it('applies no severity filter for severity:all', async () => {
    const out = await port().latestFindings({ tool: 'fit', severity: 'all' });
    expect(out.ok && out.value.data.map((f) => f.ruleId).sort()).toEqual(['err-rule', 'warn-rule']);
  });

  it('returns a structured err when no run exists for the tool', async () => {
    const out = await port().latestFindings({ tool: 'graph' });
    expect(out.ok).toBe(false);
  });
});

describe('SessionResultsReadPort — showRun', () => {
  it('replays a stored run by id with provenance + recommendedNext (never re-runs)', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-1' }));
    new RunRepo(store).saveRunWithSteps(makeRun(), [makeStep()]);
    const out = await port().showRun({ ref: 'fit-1' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.fidelity).toBe('projection');
      expect(out.value.session?.id).toBe('fit-1');
      expect(out.value.session?.ledger?.stepId).toBe('step-ledger-1');
      expect(out.value.recommendedNext?.rerunCommand).toBe('opensip fit');
    }
    expect(replayCalls).toEqual(['fit']);
  });

  it('returns a structured err for an unknown ref', async () => {
    const out = await port().showRun({ ref: 'does-not-exist' });
    expect(out.ok).toBe(false);
  });
});

describe('SessionResultsReadPort — reviewChange', () => {
  it('rebuilds a v1 ReviewBrief from stored suite step sessions in run order', async () => {
    new SessionRepo(store).save(
      makeSession({
        id: 'fit-step',
        tool: 'fit',
        startedAt: '2026-05-21T12:00:01.000Z',
        completedAt: '2026-05-21T12:00:02.000Z',
        suiteRunId: 'suite-1',
        suiteName: 'audit',
      }),
    );
    new SessionRepo(store).save(
      makeSession({
        id: 'graph-step',
        tool: 'graph',
        startedAt: '2026-05-21T12:00:03.000Z',
        completedAt: '2026-05-21T12:00:04.000Z',
        suiteRunId: 'suite-1',
        suiteName: 'audit',
      }),
    );
    const out = await new SessionResultsReadPort({
      store,
      replayFor: reviewSuiteResolver,
      agentCatalog: AGENT_CATALOG,
    }).reviewChange({
      suiteRunId: 'suite-1',
      files: ['src/a.ts'],
      graphFreshness: {
        fresh: true,
        builtAt: '2026-05-21T12:00:00.000Z',
        verifiedAt: '2026-05-21T12:00:01.000Z',
        verification: 'complete',
      },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.reviewBrief.version).toBe(1);
      expect(out.value.data.reviewBrief.suite).toBe('audit');
      expect(out.value.data.reviewBrief.topRisks.map((risk) => risk.ruleId)).toEqual(['fit-rule']);
      expect(out.value.data.reviewBrief.topRisks[0]?.signalRef.stepIndex).toBe(0);
      expect(out.value.data.reviewBrief.baselineDelta).toMatchObject({
        available: true,
        added: 1,
        unchanged: 1,
      });
      expect(out.value.data.reviewBrief.correlatedRisks).toBeUndefined();
      expect(out.value.data.source.sessionIds).toEqual(['graph-step', 'fit-step']);
      expect(out.value.data.freshness.graph?.fresh).toBe(true);
    }
    expect(replayCalls).toEqual(['graph', 'fit']);
  });

  it('rebuilds correlated risks from stored suite evidence', async () => {
    new SessionRepo(store).save(
      makeSession({
        id: 'fit-step',
        tool: 'fit',
        startedAt: '2026-05-21T12:00:01.000Z',
        completedAt: '2026-05-21T12:00:02.000Z',
        suiteRunId: 'suite-1',
        suiteName: 'audit',
      }),
    );
    new SessionRepo(store).save(
      makeSession({
        id: 'graph-step',
        tool: 'graph',
        startedAt: '2026-05-21T12:00:03.000Z',
        completedAt: '2026-05-21T12:00:04.000Z',
        suiteRunId: 'suite-1',
        suiteName: 'audit',
      }),
    );
    const out = await new SessionResultsReadPort({
      store,
      replayFor: reviewSuiteResolver,
      agentCatalog: AGENT_CATALOG,
    }).reviewChange({
      suiteRunId: 'suite-1',
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.reviewBrief.correlatedRisks).toHaveLength(1);
      expect(out.value.data.reviewBrief.correlatedRisks?.[0]).toEqual(
        expect.objectContaining({
          reasons: expect.arrayContaining([
            expect.objectContaining({
              key: expect.objectContaining({ kind: 'symbol', value: 'src/review.ts#reviewChange' }),
            }),
          ]),
          members: expect.arrayContaining([
            expect.objectContaining({ signalRef: expect.objectContaining({ tool: 'fit' }) }),
            expect.objectContaining({ signalRef: expect.objectContaining({ tool: 'graph' }) }),
          ]),
        }),
      );
    }
  });

  it('returns a degraded brief when a stored suite step cannot replay', async () => {
    new SessionRepo(store).save(
      makeSession({
        id: 'fit-step',
        tool: 'fit',
        suiteRunId: 'suite-1',
        suiteName: 'audit',
      }),
    );
    const out = await new SessionResultsReadPort({
      store,
      replayFor: corruptPayloadResolver,
      agentCatalog: AGENT_CATALOG,
    }).reviewChange({
      suiteRunId: 'suite-1',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.reviewBrief.verdict).toBe('warn');
      expect(out.value.data.reviewBrief.degraded[0]?.code).toBe('step-fault');
      expect(out.value.data.freshness.sessions.degradedSteps).toBe(1);
    }
  });

  it('returns a structured not-found error when no suite group matches', async () => {
    const out = await port().reviewChange({ suiteRunId: 'missing' });
    expect(out.ok).toBe(false);
  });

  it('does not surface a foreign-repo suite group when project-scoped', async () => {
    new SessionRepo(store).save(
      makeSession({
        id: 'foreign-fit',
        tool: 'fit',
        cwd: '/other',
        suiteRunId: 'suite-foreign',
        suiteName: 'audit',
      }),
    );
    const out = await new SessionResultsReadPort({
      store,
      projectRoot: '/proj',
      replayFor: reviewSuiteResolver,
      agentCatalog: AGENT_CATALOG,
    }).reviewChange({ suiteRunId: 'suite-foreign' });
    expect(out.ok).toBe(false);
    expect(replayCalls).toEqual([]);
  });
});

describe('SessionResultsReadPort — compareToBaseline', () => {
  it('compares replayed signals to stored baseline fingerprints', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-1', tool: 'fit' }));
    const current = compareBaselineSignals();
    const resolved = signal({ ruleId: 'resolved', fingerprint: 'fp-resolved' });
    new BaselineRepo(store).save(
      'fit',
      [
        { fingerprint: 'fp-same', payload: current[0] },
        { fingerprint: 'fp-resolved', payload: resolved },
      ],
      DEFAULT_TEST_BASELINE_IDENTITY,
    );
    const out = await new SessionResultsReadPort({
      store,
      replayFor: compareBaselineResolver,
      agentCatalog: AGENT_CATALOG,
    }).compareToBaseline({
      tool: 'fit',
      includeResolved: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.baseline.available).toBe(true);
      expect(out.value.data.delta).toEqual({
        added: 1,
        resolved: 1,
        unchanged: 1,
        missingFingerprint: 1,
      });
      expect(out.value.data.addedFindings.map((finding) => finding.ruleId)).toEqual(['new']);
      expect(out.value.data.resolvedFindings?.map((finding) => finding.ruleId)).toEqual([
        'resolved',
      ]);
      expect(out.value.data.degraded?.[0]?.code).toBe('missing-fingerprint');
    }
    expect(replayCalls).toEqual(['fit']);
  });

  it('returns degraded baseline metadata when the baseline is missing', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-1', tool: 'fit' }));
    const out = await port().compareToBaseline({ tool: 'fit' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.baseline.available).toBe(false);
      expect(out.value.data.degraded?.[0]?.code).toBe('missing-baseline');
    }
  });

  it('treats a saved empty baseline as available', async () => {
    new SessionRepo(store).save(makeSession({ id: 'fit-1', tool: 'fit' }));
    new BaselineRepo(store).save('fit', [], DEFAULT_TEST_BASELINE_IDENTITY);
    const out = await new SessionResultsReadPort({
      store,
      replayFor: newFindingResolver,
      agentCatalog: AGENT_CATALOG,
    }).compareToBaseline({
      tool: 'fit',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.baseline).toMatchObject({ available: true, rowCount: 0 });
      expect(out.value.data.delta.added).toBe(1);
    }
  });

  it('returns not-found for a foreign-repo latest session without replaying it', async () => {
    new SessionRepo(store).save(makeSession({ id: 'foreign-fit', tool: 'fit', cwd: '/other' }));
    new BaselineRepo(store).save('fit', [], DEFAULT_TEST_BASELINE_IDENTITY);
    const out = await new SessionResultsReadPort({
      store,
      projectRoot: '/proj',
      replayFor: compareBaselineResolver,
      agentCatalog: AGENT_CATALOG,
    }).compareToBaseline({ tool: 'fit' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-found');
    expect(replayCalls).toEqual([]);
  });
});

describe('SessionResultsReadPort — agentCatalog', () => {
  const SENTINEL_HOST_SUPPORT: AgentHostSupport = Object.freeze({
    supportContractVersion: 1,
    status: 'preview',
    match: 'partial',
    rowId: 'injected-sentinel-row-v1',
    rowStatus: 'preview',
    profile: { id: 'injected-sentinel-row-v1', version: 1 },
    matrixUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
    reasonCodes: [],
    observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
    unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
  });

  /** A rich common catalog with reserved names + target conventions + hostSupport. */
  function richCatalog() {
    return assembleAgentCatalog({
      rootCommands: ['audit', 'init', 'sessions', 'suite'],
      suiteNames: ['audit', 'agent-context'],
      hostSupport: SENTINEL_HOST_SUPPORT,
      projectContext: {
        targetConventions: [
          { target: 'app', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 3 },
        ],
      },
    });
  }

  /**
   * A store whose every access throws — proves `agentCatalog()` is a pure conduit
   * that never touches the datastore dependency the port owns for other methods.
   */
  const throwingStore = new Proxy(
    {},
    {
      get() {
        throw new Error('agentCatalog() must not touch the datastore');
      },
    },
  ) as unknown as DataStore;

  /** A replay resolver that throws if consulted — must never fire for a catalog read. */
  const throwingReplay: (tool: ToolShortId) => SessionReplayFn | undefined = () => {
    throw new Error('agentCatalog() must not consult session replay');
  };

  it('returns the entire assembled catalog unchanged (whole-object, same reference)', () => {
    const catalog = richCatalog();
    const out = new SessionResultsReadPort({
      store: throwingStore,
      replayFor: throwingReplay,
      agentCatalog: catalog,
    }).agentCatalog();
    expect(out.ok).toBe(true);
    if (out.ok) {
      // No hand-picked field allowlist — the WHOLE object is forwarded verbatim.
      expect(out.value).toEqual(catalog);
      // Same reference: it is the captured object, not a rebuilt one.
      expect(out.value).toBe(catalog);
    }
  });

  it('surfaces reserved/project facts and the ENTIRE Plan 02 hostSupport object', () => {
    const catalog = richCatalog();
    const out = new SessionResultsReadPort({
      store: throwingStore,
      replayFor: throwingReplay,
      agentCatalog: catalog,
    }).agentCatalog();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.reservedNames).toEqual({
      rootCommands: ['audit', 'init', 'sessions', 'suite'],
      suiteNames: ['audit', 'agent-context'],
    });
    expect(out.value.projectContext?.targetConventions).toEqual([
      { target: 'app', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 3 },
    ]);
    // The full hostSupport object (status, match, dimensions, reason codes, URL).
    expect(out.value.hostSupport).toEqual(SENTINEL_HOST_SUPPORT);
    expect(JSON.stringify(out.value.hostSupport)).toBe(JSON.stringify(SENTINEL_HOST_SUPPORT));
    // Internal commands are never surfaced on the catalog object.
    expect(out.value).not.toHaveProperty('internalCommands');
  });

  it('forwards a catalog without hostSupport as-is (absent field stays absent)', () => {
    const catalog = assembleAgentCatalog({ rootCommands: [], suiteNames: [] });
    const out = new SessionResultsReadPort({
      store: throwingStore,
      replayFor: throwingReplay,
      agentCatalog: catalog,
    }).agentCatalog();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.hostSupport).toBeUndefined();
  });
});
