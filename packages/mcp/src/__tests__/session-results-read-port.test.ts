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
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
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

describe('SessionResultsReadPort — agentCatalog', () => {
  it('returns the self-describing agent catalog', () => {
    const out = port().agentCatalog();
    expect(out.ok).toBe(true);
  });
});
