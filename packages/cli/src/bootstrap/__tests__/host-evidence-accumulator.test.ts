import {
  MAX_EVIDENCE_BUNDLE_BYTES,
  MAX_EVIDENCE_BUNDLE_SESSIONS,
  measureEvidenceBundleBytes,
} from '@opensip-cli/session-store';
import { describe, expect, it } from 'vitest';

import {
  createHostEvidenceAccumulator,
  type HostEvidenceAccumulator,
} from '../host-evidence-accumulator.js';

import type { StoredRun, StoredSession } from '@opensip-cli/contracts';

function session(id: string, payload?: unknown): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/project',
    startedAt: '2026-07-16T00:00:00.000Z',
    completedAt: '2026-07-16T00:00:01.000Z',
    durationMs: 1000,
    score: 100,
    passed: true,
    payload: payload ?? { ok: true },
  };
}

function parent(sessionId?: string): {
  readonly run: StoredRun;
  readonly steps: readonly [
    {
      readonly id: string;
      readonly runId: string;
      readonly logicalStepKey: string;
      readonly ordinal: number;
      readonly attempt: number;
      readonly tool: string;
      readonly command: string;
      readonly stableId: string;
      readonly exitCode: number;
      readonly outcome: 'passed';
      readonly durationMs: number;
      readonly sessionId?: string;
    },
  ];
} {
  return {
    run: {
      id: 'run-1',
      name: 'fit',
      source: 'implicit-tool',
      cwd: '/project',
      startedAt: '2026-07-16T00:00:00.000Z',
      completedAt: '2026-07-16T00:00:01.000Z',
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
    },
    steps: [
      {
        id: 'step-1',
        runId: 'run-1',
        logicalStepKey: '0:fit:fit',
        ordinal: 0,
        attempt: 1,
        tool: 'fit',
        command: 'fit',
        stableId: 'fit',
        exitCode: 0,
        outcome: 'passed',
        durationMs: 1000,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    ],
  };
}

function stageOne(accumulator: HostEvidenceAccumulator, id = 'session-1') {
  const owner = accumulator.createOwner('ordinary');
  expect(accumulator.stageSession(owner, session(id))).toBe(true);
  return owner;
}

describe('createHostEvidenceAccumulator', () => {
  it('accepts an exact canonical byte bound and poisons at one byte over', () => {
    const entry = { session: session('session-1'), hostMetrics: {} };
    const bytes = measureEvidenceBundleBytes({ sessions: [entry] });

    const exact = createHostEvidenceAccumulator({ maxBytes: bytes });
    const exactOwner = exact.createOwner('ordinary');
    expect(exact.stageSession(exactOwner, entry.session)).toBe(true);
    expect(exact.drain(exactOwner)).toMatchObject({ status: 'drained' });

    const over = createHostEvidenceAccumulator({ maxBytes: bytes - 1 });
    const overOwner = over.createOwner('ordinary');
    expect(over.stageSession(overOwner, entry.session)).toBe(false);
    expect(over.isSessionLinkable(overOwner, entry.session.id)).toBe(false);
    expect(over.drain(overOwner)).toEqual({ status: 'poisoned', reason: 'byte-limit' });
  });

  it('poisons the complete owner at the Session count bound and commits no prefix', () => {
    const accumulator = createHostEvidenceAccumulator({ maxSessions: 1 });
    const owner = stageOne(accumulator);
    expect(accumulator.stageSession(owner, session('session-2'))).toBe(false);
    expect(accumulator.isSessionLinkable(owner, 'session-1')).toBe(false);
    expect(accumulator.isSessionLinkable(owner, 'session-2')).toBe(false);
    expect(accumulator.drain(owner)).toEqual({
      status: 'poisoned',
      reason: 'session-limit',
    });
  });

  it('snapshots payloads with the same JSON semantics used by persistence', () => {
    const accumulator = createHostEvidenceAccumulator();
    const owner = accumulator.createOwner('ordinary');
    const source = {
      count: 1,
      toJSON() {
        return { kind: 'custom-json', count: this.count };
      },
    };
    expect(
      accumulator.stageSession(
        owner,
        session('session-json', {
          source,
          bytes: Buffer.from([1, 2, 3]),
        }),
      ),
    ).toBe(true);

    source.count = 99;
    expect(accumulator.stagedSession(owner, 'session-json')?.payload).toEqual({
      source: { kind: 'custom-json', count: 1 },
      bytes: { type: 'Buffer', data: [1, 2, 3] },
    });
    expect(accumulator.drain(owner)).toMatchObject({ status: 'drained' });
  });

  it('poisons when host-metric growth crosses the exact byte budget', () => {
    const bare = { session: session('session-1'), hostMetrics: {} };
    const bytes = measureEvidenceBundleBytes({ sessions: [bare] });
    const accumulator = createHostEvidenceAccumulator({ maxBytes: bytes + 5 });
    const owner = stageOne(accumulator);
    expect(accumulator.mergeHostMetrics(owner, 'session-1', { totalCommandMs: 123 })).toBe(false);
    expect(accumulator.isSessionLinkable(owner, 'session-1')).toBe(false);
    expect(accumulator.drain(owner)).toEqual({ status: 'poisoned', reason: 'byte-limit' });
  });

  it('rechecks the byte budget when the parent projection is attached', () => {
    const entry = { session: session('session-1'), hostMetrics: {} };
    const sessionBytes = measureEvidenceBundleBytes({ sessions: [entry] });
    const accumulator = createHostEvidenceAccumulator({ maxBytes: sessionBytes });
    const owner = stageOne(accumulator);
    expect(accumulator.drain(owner, { run: parent('session-1') })).toEqual({
      status: 'poisoned',
      reason: 'byte-limit',
    });
  });

  it('accepts the exact total byte bound for sessions and the parent run', () => {
    const entry = { session: session('session-1'), hostMetrics: {} };
    const run = parent(entry.session.id);
    const bundleBytes = measureEvidenceBundleBytes({ sessions: [entry], run });
    const accumulator = createHostEvidenceAccumulator({ maxBytes: bundleBytes });
    const owner = stageOne(accumulator, entry.session.id);

    expect(accumulator.drain(owner, { run })).toMatchObject({
      status: 'drained',
      input: {
        sessions: [entry],
        run,
      },
    });
  });

  it('drain and discard are idempotent and discard deletes owner state', () => {
    const accumulator = createHostEvidenceAccumulator();
    const owner = stageOne(accumulator);
    const first = accumulator.drain(owner, { run: parent('session-1') });
    if (first.status === 'drained') {
      expect(Object.isFrozen(first.input.sessions[0])).toBe(true);
      expect(() => {
        (
          first.input.sessions[0] as {
            session: StoredSession;
          }
        ).session = session('mutated');
      }).toThrow(TypeError);
    }
    expect(accumulator.drain(owner, { run: parent('other') })).toBe(first);
    accumulator.discard(owner);
    accumulator.discard(owner);
    expect(accumulator.ownerKind(owner)).toBeUndefined();
    expect(accumulator.drain(owner)).toEqual({ status: 'discarded' });
  });

  it('queues at most one child effect and permits one host-owned replacement', () => {
    const accumulator = createHostEvidenceAccumulator();
    const owner = accumulator.createOwner('nested');
    expect(accumulator.queueReportEffect(owner, { kind: 'compose-and-open' })).toBe(true);
    expect(
      accumulator.queueReportEffect(owner, {
        kind: 'compose-and-open',
        selection: { view: 'change-impact', runId: 'ignored' },
      }),
    ).toBe(true);
    expect(
      accumulator.replaceReportEffect(owner, {
        kind: 'compose-and-open',
        selection: { view: 'change-impact', runId: 'run-exact' },
      }),
    ).toBe(true);
    expect(accumulator.drain(owner)).toMatchObject({
      status: 'drained',
      reportEffect: {
        selection: { view: 'change-impact', runId: 'run-exact' },
      },
    });
  });

  it('clears a child queued report effect when the host replacement is undefined', () => {
    const accumulator = createHostEvidenceAccumulator();
    const owner = accumulator.createOwner('nested');
    expect(
      accumulator.queueReportEffect(owner, {
        kind: 'compose-and-open',
        selection: { view: 'change-impact', runId: 'child-run' },
      }),
    ).toBe(true);

    expect(accumulator.replaceReportEffect(owner, undefined)).toBe(true);
    expect(accumulator.drain(owner)).not.toHaveProperty('reportEffect');
  });

  it('removes only the requested current Session from a nested owner', () => {
    const accumulator = createHostEvidenceAccumulator();
    const owner = accumulator.createOwner('nested');
    expect(accumulator.stageSession(owner, session('accepted'))).toBe(true);
    expect(accumulator.stageSession(owner, session('forbidden'))).toBe(true);
    expect(accumulator.discardSession(owner, 'forbidden')).toBe(true);
    const drained = accumulator.drain(owner);
    expect(drained).toMatchObject({ status: 'drained' });
    if (drained.status === 'drained') {
      expect(drained.input.sessions.map((entry) => entry.session.id)).toEqual(['accepted']);
    }
  });

  it('rejects injected limits above the session-store hard boundary', () => {
    expect(() =>
      createHostEvidenceAccumulator({ maxSessions: MAX_EVIDENCE_BUNDLE_SESSIONS + 1 }),
    ).toThrow(RangeError);
    expect(() =>
      createHostEvidenceAccumulator({ maxBytes: MAX_EVIDENCE_BUNDLE_BYTES + 1 }),
    ).toThrow(RangeError);
  });
});
