import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_TASK_CONTEXT_MANIFEST_BYTES,
  MAX_TASK_CONTEXT_PLANES,
  buildTaskContextProjectIdentity,
  taskContextManifestSchema,
} from '@opensip-cli/contracts';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunRepo } from '../run-repo.js';
import { SessionRepo } from '../session-repo.js';

import type {
  StoredRun,
  StoredRunStep,
  StoredSession,
  TaskContextManifest,
} from '@opensip-cli/contracts';

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: 'run-test-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 2,
      passed: 2,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    legacySuiteRunId: 'suite-legacy-1',
    cliVersion: '0.5.0',
    ...overrides,
  };
}

function makeStep(overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-test-1',
    runId: 'run-test-1',
    logicalStepKey: '0:fit:fitness',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    effectiveArgs: { recipe: 'agent-risk' },
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    evidence: { findings: 0 },
    ...overrides,
  };
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-test-1',
    tool: 'fit',
    startedAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T12:00:00.250Z',
    cwd: '/proj',
    recipe: 'agent-risk',
    score: 100,
    passed: true,
    durationMs: 250,
    ...overrides,
  };
}

function contextManifest(runId: string, planeCount = 3, cwd = '/proj'): TaskContextManifest {
  const kinds = ['inventory', 'graph', 'test-selection'] as const;
  const pointerId = (kind: (typeof kinds)[number], index: number): string => {
    const digest = (index + 1).toString(16).padStart(64, '0');
    if (kind === 'inventory') return `i1:${digest}`;
    if (kind === 'graph') return `g1:${digest}`;
    return `ts1:${digest}`;
  };
  const planes = Array.from({ length: planeCount }, (_value, index) => {
    const kind = kinds[index % kinds.length];
    return {
      kind,
      required: kind !== 'test-selection',
      status: 'rebuilt' as const,
      producer: {
        toolId: 'graph-id',
        command: `graph-context-${kind}`,
        version: '1.0.0',
      },
      pointer: {
        owner: 'graph' as const,
        kind,
        id: pointerId(kind, index),
        schemaVersion: 1,
      },
      step: {
        runId,
        stepId: `STEP_${'0'.repeat(25)}${String(index % 10)}`,
        logicalStepKey: `${String(index)}:graph:context`,
        ordinal: index,
        attempt: 1,
      },
      freshness: { status: 'current' as const, reasonCodes: [] },
      coverage: {
        status: 'complete' as const,
        reasonCodes: [],
        observed: 1,
        total: 1,
      },
      caps: { status: 'not-hit' as const, reasonCodes: [] },
      reasonCodes: [],
      followUpReads: ['get_context_status'],
    };
  });
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-13T00:00:00.000Z',
    projectIdentity: buildTaskContextProjectIdentity(cwd),
    readiness: planeCount === 3 ? 'ready' : 'unavailable',
    sourceStart: {
      configIdentity: `sha256:${'1'.repeat(64)}`,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'2'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: `sha256:${'1'.repeat(64)}`,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'2'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    fileScope: {
      mode: 'project',
      fileCount: 0,
      filesIdentity: `sha256:${'0'.repeat(64)}`,
    },
    graphIdentity: planes.find((plane) => plane.kind === 'graph')?.pointer.id,
    inventoryIdentity: planes.find((plane) => plane.kind === 'inventory')?.pointer.id,
    planes,
    reasonCodes: [],
    nextActions: ['get_context_status'],
  };
}

function contextSteps(manifest: TaskContextManifest): readonly StoredRunStep[] {
  return manifest.planes.map((plane) => ({
    id: plane.step.stepId,
    runId: manifest.runId,
    logicalStepKey: plane.step.logicalStepKey,
    ordinal: plane.step.ordinal,
    attempt: 1,
    tool: 'graph',
    command: plane.producer.command,
    stableId: 'graph-id',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 1,
  }));
}

function largestValidContextManifest(runId: string, cwd = '/proj'): TaskContextManifest {
  const base = contextManifest(runId, 3, cwd);
  const reasonCodes = Array.from({ length: 32 }, () => 'r'.repeat(128));
  const planes = base.planes.map((plane) => ({
    ...plane,
    producer: {
      toolId: 't'.repeat(214),
      command: 'c'.repeat(128),
      version: 'v'.repeat(128),
    },
    pointer: plane.pointer,
    step: { ...plane.step, logicalStepKey: 'l'.repeat(512) },
    freshness: { ...plane.freshness, reasonCodes },
    coverage: { ...plane.coverage, reasonCodes },
    reasonCodes,
    followUpReads: Array.from({ length: 16 }, () => 'get_context_status'),
  }));
  const graphPlane = planes.find((plane) => plane.kind === 'graph');
  const inventoryPlane = planes.find((plane) => plane.kind === 'inventory');
  if (graphPlane?.pointer === undefined || inventoryPlane?.pointer === undefined) {
    throw new TypeError('largest context manifest fixture is missing required pointers');
  }
  return {
    ...base,
    readiness: 'degraded',
    sourceStart: {
      configIdentity: `sha256:${'3'.repeat(64)}`,
      gitHead: 'b'.repeat(40),
      worktreeIdentity: `sha256:${'4'.repeat(64)}`,
      dirty: true,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: `sha256:${'3'.repeat(64)}`,
      gitHead: 'b'.repeat(40),
      worktreeIdentity: `sha256:${'4'.repeat(64)}`,
      dirty: true,
      status: 'captured',
      reasonCodes: [],
    },
    graphIdentity: graphPlane.pointer.id,
    inventoryIdentity: inventoryPlane.pointer.id,
    planes,
    reasonCodes,
    nextActions: Array.from(
      { length: 16 },
      () => 'opensip suite run agent-context --files <same-explicit-files> --json',
    ),
  };
}

let datastore: DataStore;
let repo: RunRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new RunRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('RunRepo', () => {
  it('round-trips a run with ordered steps', () => {
    const run = makeRun();
    repo.saveRunWithSteps(run, [
      makeStep({ id: 'step-2', ordinal: 1, logicalStepKey: '1:graph:impact' }),
      makeStep({ id: 'step-1', ordinal: 0, logicalStepKey: '0:fit:fitness' }),
    ]);

    expect(repo.getRun(run.id)).toEqual(run);
    expect(repo.listStepsForRun(run.id).map((step) => step.id)).toEqual(['step-1', 'step-2']);
  });

  it('writes neither parent nor steps when the locked transactional precondition fails', () => {
    const handle = requireDrizzleHandle(datastore);
    const originalLock = handle.withWriteLock.bind(handle);
    const originalTransaction = handle.transaction.bind(handle);
    let lockHeld = false;
    let transactionEntered = false;
    vi.spyOn(handle, 'withWriteLock').mockImplementation((operation, fn) =>
      originalLock(operation, () => {
        lockHeld = true;
        try {
          return fn();
        } finally {
          lockHeld = false;
        }
      }),
    );
    vi.spyOn(handle, 'transaction').mockImplementation((fn) =>
      originalTransaction((tx) => {
        transactionEntered = true;
        try {
          return fn(tx);
        } finally {
          transactionEntered = false;
        }
      }),
    );
    const precondition = vi.fn(() => {
      expect(lockHeld).toBe(true);
      expect(transactionEntered).toBe(true);
      expect(repo.getRun('missing-before-commit')).toBeNull();
      return false;
    });

    expect(repo.saveRunWithStepsIf(makeRun(), [makeStep()], precondition)).toBe(false);
    expect(precondition).toHaveBeenCalledOnce();
    expect(repo.listRuns()).toEqual([]);
    expect(repo.listStepsForRun('run-test-1')).toEqual([]);
  });

  it('round-trips both evidence vocabularies without interpreting their fields', () => {
    const signalEvidence = {
      kind: 'signal-envelope',
      schemaVersion: 2,
      tool: 'fit',
      runId: 'tool-run-1',
      signalCount: 1,
      futureVocabulary: { confidence: 'experimental' },
    };
    const snapshotEvidence = {
      kind: 'evidence-snapshots',
      schemaVersion: 1,
      snapshots: [
        {
          kind: 'inventory',
          status: 'rebuilt',
          snapshotId: 'inventory-1',
          snapshotSchemaVersion: 1,
          futureVocabulary: ['opaque'],
        },
      ],
    };
    repo.saveRunWithSteps(
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
      [
        makeStep({ id: 'step-signal', evidence: signalEvidence }),
        makeStep({
          id: 'step-snapshot',
          ordinal: 1,
          logicalStepKey: '1:graph:graph-context-inventory',
          evidence: snapshotEvidence,
        }),
      ],
    );

    expect(repo.listStepsForRun('run-test-1').map((step) => step.evidence)).toEqual([
      signalEvidence,
      snapshotEvidence,
    ]);
  });

  it('filters by exact project and run name with deterministic newest-first ties', () => {
    const completedAt = '2026-07-08T12:00:01.000Z';
    repo.saveRun(makeRun({ id: 'context-a', name: 'agent-context', completedAt }));
    repo.saveRun(makeRun({ id: 'context-b', name: 'agent-context', completedAt }));
    repo.saveRun(makeRun({ id: 'audit-z', name: 'audit', completedAt }));
    repo.saveRun(
      makeRun({
        id: 'foreign-z',
        name: 'agent-context',
        cwd: '/other',
        completedAt,
      }),
    );

    expect(repo.listRuns({ cwd: '/proj', name: 'agent-context' }).map((run) => run.id)).toEqual([
      'context-b',
      'context-a',
    ]);
    expect(repo.listRuns({ cwd: '/proj', name: 'agent-context', limit: 1 })[0]?.id).toBe(
      'context-b',
    );
  });

  it('keeps run-context vocabulary opaque while enforcing the serialized-byte limit', () => {
    const opaqueRunId = 'context-opaque';
    const opaqueManifest = contextManifest(opaqueRunId, MAX_TASK_CONTEXT_PLANES + 1);
    expect(taskContextManifestSchema.safeParse(opaqueManifest).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(opaqueManifest), 'utf8')).toBeLessThanOrEqual(
      MAX_TASK_CONTEXT_MANIFEST_BYTES,
    );
    repo.saveRun(
      makeRun({
        id: opaqueRunId,
        name: 'agent-context',
        contextManifest: opaqueManifest,
      }),
    );
    expect(repo.getRun(opaqueRunId)?.contextManifest).toEqual(opaqueManifest);

    const runId = `RUN_${'5'.repeat(26)}`;
    const valid = largestValidContextManifest(runId);
    const oversized = {
      ...valid,
      readiness: 'unavailable',
      planes: Array.from({ length: MAX_TASK_CONTEXT_PLANES }, (_value, index) => ({
        ...valid.planes[index % valid.planes.length],
        step: {
          ...valid.planes[index % valid.planes.length].step,
          stepId: `oversized-step-${String(index)}`,
          ordinal: index,
        },
      })),
    } as TaskContextManifest;
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      MAX_TASK_CONTEXT_MANIFEST_BYTES,
    );
    const parsedOversized = taskContextManifestSchema.safeParse(oversized);
    expect(parsedOversized.success).toBe(false);
    if (parsedOversized.success) return;
    expect(parsedOversized.error.issues.map((issue) => issue.message)).toContain(
      'task-context manifest exceeds 64 KiB',
    );
    expect(() =>
      repo.saveRun(
        makeRun({
          id: runId,
          name: 'agent-context',
          contextManifest: oversized,
        }),
      ),
    ).toThrow(/Invalid bounded run context/u);
    expect(repo.getRun(runId)).toBeNull();
  });

  it('rejects opaque run context that cannot produce bounded JSON', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const serializesToUndefined = { toJSON: () => undefined };

    for (const [id, contextManifest] of [
      ['context-circular', circular],
      ['context-undefined-json', serializesToUndefined],
    ] as const) {
      expect(() =>
        repo.saveRun(
          makeRun({
            id,
            contextManifest: contextManifest as unknown as StoredRun['contextManifest'],
          }),
        ),
      ).toThrow(/Invalid bounded run context/u);
      expect(repo.getRun(id)).toBeNull();
    }
  });

  it('reopens a file-backed maximum-shaped v1 manifest below 64 KiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'context-manifest-'));
    const path = join(root, 'datastore.sqlite');
    const runId = `RUN_${'6'.repeat(26)}`;
    const manifest = largestValidContextManifest(runId, root);
    const bytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    expect(bytes).toBeGreaterThan(40 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_TASK_CONTEXT_MANIFEST_BYTES);
    expect(manifest.planes).toHaveLength(3);
    expect(taskContextManifestSchema.safeParse(manifest).success).toBe(true);

    let fileStore: DataStore | undefined;
    try {
      fileStore = DataStoreFactory.open({ backend: 'sqlite', path });
      new RunRepo(fileStore).saveRunWithSteps(
        makeRun({
          id: runId,
          name: 'agent-context',
          cwd: root,
          aggregate: {
            steps: manifest.planes.length,
            passed: manifest.planes.length,
            failed: 0,
            faulted: 0,
            errors: 0,
            warnings: 0,
          },
          contextManifest: manifest,
        }),
        contextSteps(manifest),
      );
      fileStore.close();
      fileStore = undefined;
      fileStore = DataStoreFactory.open({ backend: 'sqlite', path });
      const reopened = new RunRepo(fileStore);
      expect(reopened.getRun(runId)?.contextManifest).toEqual(manifest);
      expect(reopened.listStepsForRun(runId)).toHaveLength(manifest.planes.length);
    } finally {
      fileStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('upserts repeated run and step ids instead of duplicating rows', () => {
    const run = makeRun();
    repo.saveRunWithSteps(run, [makeStep()]);
    repo.saveRunWithSteps(
      {
        ...run,
        exitCode: 1,
        aggregate: { ...run.aggregate, failed: 1, passed: 1 },
      },
      [makeStep({ exitCode: 1, outcome: 'failed' })],
    );

    expect(repo.listRuns()).toHaveLength(1);
    expect(repo.listStepsForRun(run.id)).toHaveLength(1);
    expect(repo.getRun(run.id)?.exitCode).toBe(1);
    expect(repo.listStepsForRun(run.id)[0]?.outcome).toBe('failed');
  });

  it('looks up runs by legacy suite id and steps by linked session id', () => {
    new SessionRepo(datastore).save(makeSession());
    const run = makeRun();
    const step = makeStep({ sessionId: 'session-test-1' });
    repo.saveRunWithSteps(run, [step]);

    expect(repo.getRunByLegacySuiteRunId('suite-legacy-1')?.id).toBe(run.id);
    expect(repo.getStepBySessionId('session-test-1')).toEqual(step);
  });

  it('finds an implicit run by exact correlation id, tool, and command', () => {
    repo.saveRunWithSteps(
      makeRun({
        id: 'implicit-run',
        source: 'implicit-tool',
        correlationRunId: 'correlation-1',
      }),
      [
        makeStep({
          id: 'implicit-step',
          runId: 'implicit-run',
          tool: 'graph',
          command: 'graph',
        }),
      ],
    );

    const beforeRun = '2026-07-08T11:59:59.000Z';
    expect(repo.hasImplicitRunForCommand('correlation-1', 'graph', 'graph', beforeRun)).toBe(true);
    expect(repo.hasImplicitRunForCommand('other-correlation', 'graph', 'graph', beforeRun)).toBe(
      false,
    );
    expect(repo.hasImplicitRunForCommand('correlation-1', 'fit', 'graph', beforeRun)).toBe(false);
    expect(repo.hasImplicitRunForCommand('correlation-1', 'graph', 'impact', beforeRun)).toBe(
      false,
    );
    expect(
      repo.hasImplicitRunForCommand('correlation-1', 'graph', 'graph', '2026-07-08T12:00:00.001Z'),
    ).toBe(false);
    expect(repo.hasImplicitRunForCommand('correlation-1', 'graph', 'graph', 'invalid')).toBe(false);
  });

  it('does not treat a suite run as delegated implicit-run evidence', () => {
    repo.saveRunWithSteps(makeRun({ correlationRunId: 'correlation-1' }), [makeStep()]);

    expect(
      repo.hasImplicitRunForCommand('correlation-1', 'fit', 'fitness', '2026-07-08T11:59:59.000Z'),
    ).toBe(false);
  });

  it('enforces at most one run step per linked session', () => {
    new SessionRepo(datastore).save(makeSession());
    repo.saveRunWithSteps(makeRun({ id: 'run-a' }), [
      makeStep({ id: 'step-a', runId: 'run-a', sessionId: 'session-test-1' }),
    ]);

    expect(() =>
      repo.saveRunWithSteps(makeRun({ id: 'run-b', legacySuiteRunId: 'suite-b' }), [
        makeStep({
          id: 'step-b',
          runId: 'run-b',
          sessionId: 'session-test-1',
        }),
      ]),
    ).toThrow(/UNIQUE constraint failed: run_steps\.session_id/);
  });

  it('groups steps for multiple runs', () => {
    repo.saveRunWithSteps(makeRun({ id: 'run-a' }), [
      makeStep({ id: 'a-0', runId: 'run-a', ordinal: 0 }),
    ]);
    repo.saveRunWithSteps(makeRun({ id: 'run-b', legacySuiteRunId: 'suite-b' }), [
      makeStep({ id: 'b-0', runId: 'run-b', ordinal: 0 }),
      makeStep({
        id: 'b-1',
        runId: 'run-b',
        ordinal: 1,
        logicalStepKey: '1:yagni:yagni',
      }),
    ]);

    const byRun = repo.listStepsForRuns(['run-a', 'run-b']);
    expect(byRun.get('run-a')?.map((step) => step.id)).toEqual(['a-0']);
    expect(byRun.get('run-b')?.map((step) => step.id)).toEqual(['b-0', 'b-1']);
  });
});
