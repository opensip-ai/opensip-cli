import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeFailure } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
  listParentRuns,
  resolveParentRun,
  resolveParentRunEvidence,
} from '../run-reads.js';
import { RunRepo } from '../run-repo.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';

function makeRun(id: string, overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id,
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 0,
      passed: 0,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    ...overrides,
  };
}

function makeStep(
  runId: string,
  id: string,
  ordinal: number,
  overrides: Partial<StoredRunStep> = {},
): StoredRunStep {
  return {
    id,
    runId,
    logicalStepKey: `${String(ordinal)}:fit:${id}`,
    ordinal,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: `stable-${id}`,
    exitCode: 0,
    outcome: 'passed',
    durationMs: 10,
    evidence: { id },
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id,
    tool: 'fit',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:00.010Z',
    cwd: '/proj',
    score: 100,
    passed: true,
    durationMs: 10,
    payload: { __version: 1, id, detail: 'evidence' },
    ...overrides,
  };
}

function insertLegacyRunRow(
  store: DataStore,
  id: string,
  completedAt: string,
  cwd = '/proj',
): void {
  requireDrizzleHandle(store)
    .db.insert(runs)
    .values({
      id,
      name: 'legacy',
      source: 'reconstructed',
      cwd,
      started_at: Date.parse('2026-07-08T12:00:00.000Z'),
      started_at_iso: '2026-07-08T12:00:00.000Z',
      completed_at: Date.parse(completedAt),
      completed_at_iso: completedAt,
      duration_ms: 1,
      exit_code: 0,
      aggregate: {
        steps: 0,
        passed: 0,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    })
    .run();
}

function expectValidationCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(expect.objectContaining({ name: 'ValidationError', code }));
}

let datastore: DataStore;
let runsRepo: RunRepo;
let sessionsRepo: SessionRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  runsRepo = new RunRepo(datastore);
  sessionsRepo = new SessionRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('listParentRuns', () => {
  it('returns an immutable empty default page', () => {
    const result = listParentRuns(datastore);

    expect(result).toEqual({
      runs: [],
      requestedLimit: 20,
      effectiveLimit: 20,
      truncated: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.runs)).toBe(true);
  });

  it('orders newest-first with an ID tie-break and proves truncation via limit+1', () => {
    const completedAt = '2026-07-08T12:00:01.000Z';
    runsRepo.saveRun(makeRun('run-a', { completedAt }));
    runsRepo.saveRun(makeRun('run-c', { completedAt }));
    runsRepo.saveRun(makeRun('run-b', { completedAt }));
    runsRepo.saveRun(
      makeRun('run-new', {
        completedAt: '2026-07-09T12:00:01.000Z',
      }),
    );

    expect(listParentRuns(datastore, { limit: 3 })).toMatchObject({
      runs: [{ id: 'run-new' }, { id: 'run-c' }, { id: 'run-b' }],
      requestedLimit: 3,
      effectiveLimit: 3,
      truncated: true,
    });
  });

  it('rejects invalid public list bounds with a stable typed code', () => {
    for (const limit of [0, -1, 1.5, 501, Number.NaN]) {
      expectValidationCode(
        () => listParentRuns(datastore, { limit }),
        'SESSION.READ.BOUND_INVALID',
      );
    }
  });

  it('carries a registered definition so the real validation message survives normalization (regression)', () => {
    // requirePositiveLimit's registered code must resolve to a real
    // ErrorDefinition; without one, normalizeFailure falls back to the
    // catch-all UNKNOWN_FAILURE definition and discards the actionable
    // message in favor of "An unexpected internal failure occurred."
    let caught: unknown;
    try {
      listParentRuns(datastore, { limit: 0 });
    } catch (error) {
      caught = error;
    }
    const failure = normalizeFailure(caught);
    expect(failure.code).toBe('SESSION.READ.BOUND_INVALID');
    expect(failure.definition.code).toBe('SESSION.READ.BOUND_INVALID');
    expect(failure.message).toContain('parent Run list limit must be an integer between 1 and 500');
    expect(failure.message).not.toContain('unexpected internal failure');
  });

  it('rejects unsafe new Run IDs at write time', () => {
    for (const id of ['', 'unsafe/id', 'unsafe id', 'é', 'x'.repeat(129)]) {
      expectValidationCode(() => runsRepo.saveRun(makeRun(id)), 'SESSION.WRITE.RECORD_INVALID');
    }
  });

  it('fails explicitly when any unsafe legacy ID would make history incomplete', () => {
    const completedAt = '2026-07-08T12:00:01.000Z';
    runsRepo.saveRun(makeRun('safe-a', { completedAt }));
    insertLegacyRunRow(datastore, 'unsafe/legacy', '2026-01-01T00:00:00.000Z');

    expect(() => listParentRuns(datastore, { limit: 1 })).toThrow(
      expect.objectContaining({
        name: 'SystemError',
        code: 'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE',
      }),
    );
  });

  it('round-trips every safely listed identity through exact show', () => {
    const completedAt = '2026-07-08T12:00:01.000Z';
    runsRepo.saveRun(makeRun('safe-a', { completedAt }));
    runsRepo.saveRun(makeRun('safe-b', { completedAt }));

    const listed = listParentRuns(datastore, { limit: 1 });
    expect(listed.runs.map((run) => run.id)).toEqual(['safe-b']);
    expect(listed.truncated).toBe(true);
    for (const run of listed.runs) {
      expect(resolveParentRun(datastore, { runId: run.id })).toMatchObject({
        status: 'found',
        run: { id: run.id },
      });
    }
  });

  it('applies cwd scope before the limit and ignores foreign unsafe legacy identities', () => {
    runsRepo.saveRun(
      makeRun('local-old', {
        cwd: '/local',
        completedAt: '2026-07-08T12:00:01.000Z',
      }),
    );
    runsRepo.saveRun(
      makeRun('foreign-new', {
        cwd: '/foreign',
        completedAt: '2026-07-10T12:00:01.000Z',
      }),
    );
    insertLegacyRunRow(datastore, 'unsafe/foreign', '2026-07-11T12:00:01.000Z', '/foreign');

    expect(listParentRuns(datastore, { limit: 1, cwdWithin: '/local' })).toMatchObject({
      runs: [{ id: 'local-old' }],
      truncated: false,
    });
    expect(() => listParentRuns(datastore, { limit: 1 })).toThrow(
      expect.objectContaining({ code: 'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE' }),
    );
  });

  it('fails when a scoped unsafe legacy identity is older than the returned prefix', () => {
    runsRepo.saveRun(
      makeRun('local-new', {
        cwd: '/local',
        completedAt: '2026-07-10T12:00:01.000Z',
      }),
    );
    insertLegacyRunRow(datastore, 'unsafe/local', '2026-01-01T00:00:00.000Z', '/local/nested');

    expect(() => listParentRuns(datastore, { limit: 1, cwdWithin: '/local' })).toThrow(
      expect.objectContaining({ code: 'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE' }),
    );
  });

  it('fails closed when a raw scoped prefix normalizes outside the project root', () => {
    runsRepo.saveRun(makeRun('run-escape', { cwd: '/local/../foreign' }));

    expect(() => listParentRuns(datastore, { cwdWithin: '/local' })).toThrow(
      expect.objectContaining({ code: 'SESSION.EVIDENCE.UNSAFE_LEGACY_VALUE' }),
    );
  });

  it('scopes non-BMP Unicode project paths by code point rather than UTF-16 width', () => {
    runsRepo.saveRun(makeRun('run-unicode', { cwd: '/projects/🫖/nested' }));

    expect(listParentRuns(datastore, { cwdWithin: '/projects/🫖' })).toMatchObject({
      runs: [{ id: 'run-unicode' }],
    });
  });
});

describe('resolveParentRun', () => {
  it('reports an exact foreign parent as not found under cwd scope', () => {
    runsRepo.saveRun(makeRun('run-foreign', { cwd: '/foreign' }));

    expect(
      resolveParentRun(datastore, {
        runId: 'run-foreign',
        cwdWithin: '/local',
      }),
    ).toEqual({ status: 'not-found' });
  });

  it('resolves only an exact ID with deterministic paged steps and totals', () => {
    const run = makeRun('run-detail', {
      aggregate: {
        steps: 4,
        passed: 4,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-d', 1),
      makeStep(run.id, 'step-c', 0, { attempt: 2 }),
      makeStep(run.id, 'step-b', 0),
      makeStep(run.id, 'step-a', 0),
    ]);

    expect(runsRepo.countStepsForRun(run.id)).toBe(4);
    expect(runsRepo.listStepsForRunPage(run.id, 1, 2).map((step) => step.id)).toEqual([
      'step-b',
      'step-c',
    ]);
    const result = resolveParentRun(datastore, {
      runId: run.id,
      offset: 1,
      limit: 2,
    });
    expect(result).toMatchObject({
      status: 'found',
      run: { id: run.id },
      steps: [{ id: 'step-b' }, { id: 'step-c' }],
      total: 4,
      offset: 1,
      limit: 2,
      nextOffset: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'found') {
      expect(Object.isFrozen(result.run)).toBe(true);
      expect(Object.isFrozen(result.steps)).toBe(true);
    }
  });

  it('preserves opaque review/context records and returns no next offset at the end', () => {
    const reviewBrief = {
      schemaVersion: 99,
      future: { explanation: ['opaque', 'preserved'] },
    } as unknown as StoredRun['reviewBrief'];
    const contextManifest = {
      schemaVersion: 99,
      future: { pointers: ['opaque'] },
    } as unknown as StoredRun['contextManifest'];
    const run = makeRun('run-opaque', { reviewBrief, contextManifest });
    runsRepo.saveRunWithSteps(run, [makeStep(run.id, 'step-only', 0)]);

    expect(resolveParentRun(datastore, { runId: run.id, offset: 0, limit: 10 })).toEqual({
      status: 'found',
      run,
      steps: [makeStep(run.id, 'step-only', 0)],
      total: 1,
      offset: 0,
      limit: 10,
    });
  });

  it('returns typed not-found without falling back to name, legacy ID, or latest', () => {
    runsRepo.saveRun(
      makeRun('run-exact', {
        name: 'missing',
        legacySuiteRunId: 'run-missing',
      }),
    );

    expect(resolveParentRun(datastore, { runId: 'run-missing' })).toEqual({
      status: 'not-found',
    });
  });

  it('does not hydrate a linked Session payload for normal detail', () => {
    sessionsRepo.save(makeSession('session-corrupt'));
    const run = makeRun('run-no-hydration');
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-linked', 0, { sessionId: 'session-corrupt' }),
    ]);
    requireDrizzleHandle(datastore)
      .db.update(sessions)
      .set({ tool: '' })
      .where(eq(sessions.id, 'session-corrupt'))
      .run();

    expect(resolveParentRun(datastore, { runId: run.id })).toMatchObject({
      status: 'found',
      steps: [{ sessionId: 'session-corrupt' }],
    });
    expect(() =>
      resolveParentRunEvidence(datastore, {
        runId: run.id,
      }),
    ).toThrow(/invalid tool value/u);
  });

  it('validates the opaque shell-safe ID, offset, and page bound', () => {
    runsRepo.saveRun(makeRun('run-valid'));
    for (const runId of ['', 'slash/not-safe', 'x'.repeat(129)]) {
      expectValidationCode(
        () => resolveParentRun(datastore, { runId }),
        'SESSION.WRITE.RECORD_INVALID',
      );
    }
    expectValidationCode(
      () => resolveParentRun(datastore, { runId: 'run-valid', offset: -1 }),
      'SESSION.READ.BOUND_INVALID',
    );
    expectValidationCode(
      () =>
        resolveParentRun(datastore, {
          runId: 'run-valid',
          offset: Number.MAX_SAFE_INTEGER,
        }),
      'SESSION.READ.BOUND_INVALID',
    );
    expect(
      resolveParentRun(datastore, {
        runId: 'run-valid',
        offset: Number.MAX_SAFE_INTEGER - 500,
      }),
    ).toEqual({
      status: 'found',
      run: makeRun('run-valid'),
      steps: [],
      total: 0,
      offset: Number.MAX_SAFE_INTEGER - 500,
      limit: 100,
    });
    expectValidationCode(
      () => resolveParentRun(datastore, { runId: 'run-valid', limit: 501 }),
      'SESSION.READ.BOUND_INVALID',
    );
  });
});

describe('resolveParentRunEvidence', () => {
  function saveEvidenceFixture(): StoredRun {
    sessionsRepo.save(makeSession('session-z', { payload: { order: 'second' } }));
    sessionsRepo.save(
      makeSession('session-a', {
        payload: { order: 'first', multibyte: '😀é' },
      }),
    );
    sessionsRepo.upsertHostMetrics('session-a', { persistMs: 3, renderMs: 2 });
    const run = makeRun('run-evidence', {
      aggregate: {
        steps: 4,
        passed: 4,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-unlinked', 0),
      makeStep(run.id, 'step-first-linked', 1, { sessionId: 'session-a' }),
      makeStep(run.id, 'step-second-linked', 2, { sessionId: 'session-z' }),
      makeStep(run.id, 'step-tail', 3),
    ]);
    return run;
  }

  it('hydrates exact linked Sessions in first-step order inside one immutable snapshot', () => {
    const run = saveEvidenceFixture();
    const handle = requireDrizzleHandle(datastore);
    const transaction = vi.spyOn(handle, 'transaction');

    const result = resolveParentRunEvidence(datastore, { runId: run.id });

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.snapshot.steps.map((step) => step.id)).toEqual([
      'step-unlinked',
      'step-first-linked',
      'step-second-linked',
      'step-tail',
    ]);
    expect(result.snapshot.sessions.map((session) => session.id)).toEqual([
      'session-a',
      'session-z',
    ]);
    expect(result.snapshot.sessions[0]?.payload).toEqual({
      order: 'first',
      multibyte: '😀é',
    });
    expect(result.snapshot.sessions[0]?.hostMetrics).toEqual({
      renderMs: 2,
      persistMs: 3,
    });
    expect(result.metadata).toMatchObject({
      steps: { total: 4, included: 4, truncated: false },
      sessions: { total: 2, included: 2, truncated: false },
      byteBudget: DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET,
      baseExceedsBudget: false,
      truncated: false,
    });
    expect(result.metadata.serializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(result.snapshot), 'utf8'),
    );
    expect(result.metadata.serializedBytes).toBeGreaterThan(JSON.stringify(result.snapshot).length);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.sessions[0]?.payload)).toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('reports independent total/included/truncated metadata for step and Session caps', () => {
    const run = saveEvidenceFixture();

    const stepCapped = resolveParentRunEvidence(datastore, {
      runId: run.id,
      stepLimit: 2,
      sessionLimit: 2,
    });
    expect(stepCapped).toMatchObject({
      status: 'found',
      snapshot: {
        steps: [{ id: 'step-unlinked' }, { id: 'step-first-linked' }],
        sessions: [{ id: 'session-a' }],
      },
      metadata: {
        steps: { total: 4, included: 2, truncated: true },
        sessions: { total: 2, included: 1, truncated: true },
        truncated: true,
      },
    });

    const sessionCapped = resolveParentRunEvidence(datastore, {
      runId: run.id,
      stepLimit: 4,
      sessionLimit: 1,
    });
    expect(sessionCapped).toMatchObject({
      status: 'found',
      snapshot: {
        steps: [{ id: 'step-unlinked' }, { id: 'step-first-linked' }],
        sessions: [{ id: 'session-a' }],
      },
      metadata: {
        steps: { total: 4, included: 2, truncated: true },
        sessions: { total: 2, included: 1, truncated: true },
        truncated: true,
      },
    });
  });

  it('admits complete ordered step/Session pairs at the exact canonical byte bound', () => {
    const run = saveEvidenceFixture();
    const full = resolveParentRunEvidence(datastore, { runId: run.id });
    expect(full.status).toBe('found');
    if (full.status !== 'found') return;

    const exact = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: full.metadata.serializedBytes,
    });
    expect(exact).toMatchObject({
      status: 'found',
      metadata: {
        serializedBytes: full.metadata.serializedBytes,
        truncated: false,
      },
    });
    const oneByteExtra = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: full.metadata.serializedBytes + 1,
    });
    expect(oneByteExtra).toMatchObject({
      status: 'found',
      metadata: {
        serializedBytes: full.metadata.serializedBytes,
        truncated: false,
      },
    });

    const oneByteShort = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: full.metadata.serializedBytes - 1,
    });
    expect(oneByteShort.status).toBe('found');
    if (oneByteShort.status !== 'found') return;
    expect(oneByteShort.metadata.truncated).toBe(true);
    expect(oneByteShort.metadata.serializedBytes).toBeLessThanOrEqual(
      oneByteShort.metadata.byteBudget,
    );
    expect(oneByteShort.snapshot.steps.map((step) => step.id)).not.toContain('step-tail');
  });

  it('does not admit an oversized first candidate or parse its obviously over-budget payload', () => {
    sessionsRepo.save(
      makeSession('session-oversized', {
        payload: { huge: '😀'.repeat(2000) },
      }),
    );
    const run = makeRun('run-oversized-first');
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-oversized', 0, {
        sessionId: 'session-oversized',
        evidence: { huge: 'x'.repeat(2000) },
      }),
    ]);
    const baseProbe = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: 1,
    });
    expect(baseProbe.status).toBe('found');
    if (baseProbe.status !== 'found') return;
    requireDrizzleHandle(datastore)
      .db.update(sessions)
      .set({ tool: '' })
      .where(eq(sessions.id, 'session-oversized'))
      .run();

    const result = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: baseProbe.metadata.baseBytes + 100,
    });
    expect(result).toMatchObject({
      status: 'found',
      snapshot: { steps: [], sessions: [] },
      metadata: {
        baseExceedsBudget: false,
        serializedBytes: baseProbe.metadata.baseBytes,
        truncated: true,
      },
    });
  });

  it('stops a cumulatively over-budget payload after an admitted link and never parses a corrupt tail', () => {
    sessionsRepo.save(
      makeSession('session-admitted-prefix', {
        payload: { detail: 'a'.repeat(600) },
      }),
    );
    sessionsRepo.save(
      makeSession('session-cumulative-stop', {
        payload: { detail: 'b'.repeat(900) },
      }),
    );
    sessionsRepo.save(
      makeSession('session-cumulative-solo', {
        payload: { detail: 'b'.repeat(900) },
      }),
    );
    sessionsRepo.save(makeSession('session-corrupt-tail'));
    const run = makeRun('run-lazy-payload-prefix', {
      aggregate: {
        steps: 3,
        passed: 3,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-admitted-prefix', 0, {
        sessionId: 'session-admitted-prefix',
      }),
      makeStep(run.id, 'step-cumulative-stop', 1, {
        sessionId: 'session-cumulative-stop',
      }),
      makeStep(run.id, 'step-corrupt-tail', 2, {
        sessionId: 'session-corrupt-tail',
      }),
    ]);
    const secondAloneRun = makeRun('run-second-alone', {
      aggregate: {
        steps: 1,
        passed: 1,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      },
    });
    runsRepo.saveRunWithSteps(secondAloneRun, [
      makeStep(secondAloneRun.id, 'step-second-alone', 0, {
        sessionId: 'session-cumulative-solo',
      }),
    ]);

    const firstOnly = resolveParentRunEvidence(datastore, {
      runId: run.id,
      stepLimit: 1,
    });
    const firstTwo = resolveParentRunEvidence(datastore, {
      runId: run.id,
      stepLimit: 2,
    });
    const secondAlone = resolveParentRunEvidence(datastore, {
      runId: secondAloneRun.id,
    });
    expect(firstOnly.status).toBe('found');
    expect(firstTwo.status).toBe('found');
    expect(secondAlone.status).toBe('found');
    if (
      firstOnly.status !== 'found' ||
      firstTwo.status !== 'found' ||
      secondAlone.status !== 'found'
    ) {
      return;
    }
    const cumulativeCutoff = firstTwo.metadata.serializedBytes - 1;
    expect(firstOnly.metadata.serializedBytes).toBeLessThan(cumulativeCutoff);
    expect(secondAlone.metadata.serializedBytes).toBeLessThan(cumulativeCutoff);

    const handle = requireDrizzleHandle(datastore);
    handle.db.run(
      sql.raw(
        "UPDATE session_tool_payload SET payload = '{not-json' WHERE session_id = 'session-corrupt-tail'",
      ),
    );

    const bounded = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: cumulativeCutoff,
    });
    expect(bounded).toMatchObject({
      status: 'found',
      snapshot: {
        steps: [{ id: 'step-admitted-prefix' }],
        sessions: [{ id: 'session-admitted-prefix' }],
      },
      metadata: {
        conservativePayloadPreflightTruncated: true,
        truncated: true,
      },
    });

    expect(() => resolveParentRunEvidence(datastore, { runId: run.id })).toThrow(
      expect.objectContaining({
        name: 'SystemError',
        code: 'SESSION.EVIDENCE.UNREADABLE',
      }),
    );
  });

  it('returns mandatory exact Run metadata truthfully when the base exceeds budget', () => {
    const reviewBrief = {
      detail: 'x'.repeat(512),
    } as unknown as StoredRun['reviewBrief'];
    const run = makeRun('run-large-base', { reviewBrief });
    runsRepo.saveRunWithSteps(run, [makeStep(run.id, 'step-omitted', 0)]);

    const result = resolveParentRunEvidence(datastore, {
      runId: run.id,
      byteBudget: 1,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.snapshot.run).toEqual(run);
    expect(result.snapshot.steps).toEqual([]);
    expect(result.snapshot.sessions).toEqual([]);
    expect(result.metadata.baseExceedsBudget).toBe(true);
    expect(result.metadata.serializedBytes).toBe(result.metadata.baseBytes);
    expect(result.metadata.serializedBytes).toBeGreaterThan(result.metadata.byteBudget);
    expect(result.metadata.truncated).toBe(true);
  });

  it('returns exact not-found and validates every public evidence bound', () => {
    expect(resolveParentRunEvidence(datastore, { runId: 'run-missing' })).toEqual({
      status: 'not-found',
    });
    expectValidationCode(
      () => resolveParentRunEvidence(datastore, { runId: 'not/safe' }),
      'SESSION.WRITE.RECORD_INVALID',
    );
    expectValidationCode(
      () =>
        resolveParentRunEvidence(datastore, {
          runId: 'run-valid',
          stepLimit: 0,
        }),
      'SESSION.READ.BOUND_INVALID',
    );
    expectValidationCode(
      () =>
        resolveParentRunEvidence(datastore, {
          runId: 'run-valid',
          sessionLimit: 501,
        }),
      'SESSION.READ.BOUND_INVALID',
    );
    expectValidationCode(
      () =>
        resolveParentRunEvidence(datastore, {
          runId: 'run-valid',
          byteBudget: MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET + 1,
        }),
      'SESSION.READ.BOUND_INVALID',
    );
  });

  it('treats a retained step with a missing linked Session as corruption', () => {
    sessionsRepo.save(makeSession('session-missing'));
    const run = makeRun('run-corrupt-link');
    runsRepo.saveRunWithSteps(run, [
      makeStep(run.id, 'step-corrupt-link', 0, {
        sessionId: 'session-missing',
      }),
    ]);
    const handle = requireDrizzleHandle(datastore);
    handle.db.run(sql.raw('PRAGMA foreign_keys = OFF'));
    handle.db.delete(sessions).where(eq(sessions.id, 'session-missing')).run();
    handle.db.run(sql.raw('PRAGMA foreign_keys = ON'));

    expect(() => resolveParentRunEvidence(datastore, { runId: run.id })).toThrow(
      expect.objectContaining({
        name: 'SystemError',
        code: 'SESSION.EVIDENCE.UNREADABLE',
      }),
    );
  });

  it('holds one read snapshot across a concurrent Session purge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opensip-run-read-snapshot-'));
    const path = join(directory, 'datastore.sqlite');
    const reader = DataStoreFactory.open({ backend: 'sqlite', path });
    const writer = DataStoreFactory.open({ backend: 'sqlite', path });
    try {
      const writerSessions = new SessionRepo(writer);
      const writerRuns = new RunRepo(writer);
      writerSessions.save(
        makeSession('session-snapshot', {
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.010Z',
        }),
      );
      const run = makeRun('run-snapshot');
      writerRuns.saveRunWithSteps(run, [
        makeStep(run.id, 'step-snapshot', 0, { sessionId: 'session-snapshot' }),
      ]);

      const readerHandle = requireDrizzleHandle(reader);
      const originalTransaction = readerHandle.transaction.bind(readerHandle);
      let purged = false;
      vi.spyOn(readerHandle, 'transaction').mockImplementation((work) =>
        originalTransaction((tx) => {
          tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run.id)).get();
          if (!purged) {
            expect(writerSessions.purge(new Date('2026-02-01T00:00:00.000Z'))).toBe(1);
            purged = true;
          }
          return work(tx);
        }),
      );

      const result = resolveParentRunEvidence(reader, { runId: run.id });
      expect(purged).toBe(true);
      expect(result).toMatchObject({
        status: 'found',
        snapshot: {
          steps: [{ sessionId: 'session-snapshot' }],
          sessions: [{ id: 'session-snapshot' }],
        },
      });
      expect(writerRuns.listStepsForRun(run.id)[0]?.sessionId).toBeUndefined();
      const fresh = resolveParentRunEvidence(reader, { runId: run.id });
      expect(fresh.status).toBe('found');
      if (fresh.status === 'found') {
        expect(fresh.snapshot.steps[0]?.sessionId).toBeUndefined();
        expect(fresh.snapshot.sessions).toEqual([]);
      }
    } finally {
      writer.close();
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns a pre-delete snapshot across parent retention and not-found on the fresh read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'opensip-parent-read-snapshot-'));
    const path = join(directory, 'datastore.sqlite');
    const reader = DataStoreFactory.open({ backend: 'sqlite', path });
    const writer = DataStoreFactory.open({ backend: 'sqlite', path });
    try {
      const writerRuns = new RunRepo(writer);
      const run = makeRun('run-retention-snapshot', {
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      writerRuns.saveRunWithSteps(run, [makeStep(run.id, 'step-before-delete', 0)]);

      const readerHandle = requireDrizzleHandle(reader);
      const originalTransaction = readerHandle.transaction.bind(readerHandle);
      let pruned = false;
      vi.spyOn(readerHandle, 'transaction').mockImplementation((work) =>
        originalTransaction((tx) => {
          tx.select({ id: runs.id }).from(runs).where(eq(runs.id, run.id)).get();
          if (!pruned) {
            expect(
              writerRuns.pruneOlderThanBatch(new Date('2026-02-01T00:00:00.000Z'), 1),
            ).toMatchObject({ deleted: 1 });
            pruned = true;
          }
          return work(tx);
        }),
      );

      expect(resolveParentRun(reader, { runId: run.id })).toMatchObject({
        status: 'found',
        run: { id: run.id },
        steps: [{ id: 'step-before-delete' }],
      });
      expect(writerRuns.getRun(run.id)).toBeNull();
      expect(resolveParentRun(reader, { runId: run.id })).toEqual({
        status: 'not-found',
      });
    } finally {
      writer.close();
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
