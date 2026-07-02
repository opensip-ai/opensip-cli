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
  buildSignalEnvelope,
  type ToolSessionReplay,
  type CommandResult,
  type StoredSession,
} from '@opensip-cli/contracts';
import {
  createSignal,
  HOST_VERDICT_POLICY_FALLBACK,
  type ToolShortId,
  type Signal,
} from '@opensip-cli/core';
import {
  BaselineRepo,
  DataStoreFactory,
  DEFAULT_TEST_BASELINE_IDENTITY,
  type DataStore,
} from '@opensip-cli/datastore';
import { SessionRepo, type SessionReplayFn } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionResultsReadPort } from '../session-results-read-port.js';

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
}): Signal {
  const base = createSignal({
    source: 'u',
    severity: over.severity ?? 'high',
    ruleId: over.ruleId,
    message: over.message ?? over.ruleId,
    code: { file: over.filePath ?? 'src/a.ts', line: 1, column: 0 },
    metadata: over.baselineState === undefined ? {} : { baselineState: over.baselineState },
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

function port(): SessionResultsReadPort {
  return new SessionResultsReadPort({ store, replayFor: recordingResolver });
}

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
    const out = await port().showRun({ ref: 'fit-1' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.fidelity).toBe('projection');
      expect(out.value.session?.id).toBe('fit-1');
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
    }).reviewChange({
      suiteRunId: 'suite-1',
      files: ['src/a.ts'],
      graphFreshness: { fresh: true, builtAt: '2026-05-21T12:00:00.000Z' },
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
      expect(out.value.data.source.sessionIds).toEqual(['graph-step', 'fit-step']);
      expect(out.value.data.freshness.graph?.fresh).toBe(true);
    }
    expect(replayCalls).toEqual(['graph', 'fit']);
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
    }).compareToBaseline({
      tool: 'fit',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.data.baseline).toMatchObject({ available: true, rowCount: 0 });
      expect(out.value.data.delta.added).toBe(1);
    }
  });
});

describe('SessionResultsReadPort — agentCatalog', () => {
  it('returns the self-describing agent catalog', () => {
    const out = port().agentCatalog();
    expect(out.ok).toBe(true);
  });
});
