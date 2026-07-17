import { createHash } from 'node:crypto';

import { buildTaskContextProjectIdentity } from '@opensip-cli/contracts';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readTaskContextRun } from '../context-manifest-read.js';
import { RunRepo } from '../run-repo.js';
import { runs, runSteps } from '../schema/runs.js';

import type { StoredRun, StoredRunStep, TaskContextManifest } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

const stores: DataStore[] = [];
const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
const INVENTORY_COMMAND = 'graph-context-inventory';
const INVENTORY_STEP_KEY = `0:${GRAPH_TOOL_ID}:${INVENTORY_COMMAND}`;
const INVENTORY_ID = `i1:${'1'.repeat(64)}`;
const GRAPH_ID = `g1:${'2'.repeat(64)}`;
const SELECTION_ID = `ts1:${'3'.repeat(64)}`;
const CONFIG_ID = `sha256:${'4'.repeat(64)}`;
const CLEAN_WORKTREE_ID = `sha256:${'5'.repeat(64)}`;
const DIRTY_WORKTREE_ID = `sha256:${'6'.repeat(64)}`;

function fixtureId(prefix: 'RUN' | 'STEP', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 26).toUpperCase()}`;
}

const DEFAULT_RUN_ID = fixtureId('RUN', 'run-context');
const READY_RUN_ID = fixtureId('RUN', 'run-ready');
const INVENTORY_STEP_ID = fixtureId('STEP', 'step-inventory');

const authorities = [
  {
    kind: 'inventory',
    command: INVENTORY_COMMAND,
    id: INVENTORY_ID,
    schemaVersion: 1,
  },
  {
    kind: 'graph',
    command: 'graph-context-ensure',
    id: GRAPH_ID,
    schemaVersion: 3,
  },
  {
    kind: 'test-selection',
    command: 'graph-context-select-tests',
    id: SELECTION_ID,
    schemaVersion: 1,
  },
] as const;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function open(): DataStore {
  const store = DataStoreFactory.open({ backend: 'memory' });
  stores.push(store);
  return store;
}

function step(runId = DEFAULT_RUN_ID): StoredRunStep {
  return {
    id: INVENTORY_STEP_ID,
    runId,
    logicalStepKey: INVENTORY_STEP_KEY,
    ordinal: 0,
    attempt: 1,
    tool: 'graph',
    command: INVENTORY_COMMAND,
    stableId: GRAPH_TOOL_ID,
    exitCode: 0,
    outcome: 'passed',
    durationMs: 1,
    evidence: {
      kind: 'evidence-snapshots',
      schemaVersion: 1,
      snapshots: [
        {
          kind: 'inventory',
          status: 'rebuilt',
          snapshotId: INVENTORY_ID,
          snapshotSchemaVersion: 1,
          producer: {
            toolId: GRAPH_TOOL_ID,
            command: INVENTORY_COMMAND,
            version: '1.0.0',
          },
          freshness: { status: 'current', reasonCodes: [] },
          coverage: { status: 'complete', items: 1, total: 1, reasonCodes: [] },
          reasonCodes: [],
          followUpReads: ['get_file_context'],
        },
      ],
    },
  };
}

function unavailableSteps(runId = DEFAULT_RUN_ID): StoredRunStep[] {
  return [
    step(runId),
    ...authorities.slice(1).map((authority, index) => {
      const ordinal = index + 1;
      return {
        id: fixtureId('STEP', `step-${authority.kind}`),
        runId,
        logicalStepKey: `${String(ordinal)}:${GRAPH_TOOL_ID}:${authority.command}`,
        ordinal,
        attempt: 1,
        tool: 'graph',
        command: authority.command,
        stableId: GRAPH_TOOL_ID,
        exitCode: 1,
        outcome: 'faulted' as const,
        durationMs: 1,
      };
    }),
  ];
}

function manifest(runId = DEFAULT_RUN_ID): TaskContextManifest {
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-12T00:00:00.500Z',
    projectIdentity: buildTaskContextProjectIdentity('/repo'),
    readiness: 'unavailable',
    sourceStart: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: CLEAN_WORKTREE_ID,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: CLEAN_WORKTREE_ID,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    fileScope: {
      mode: 'project',
      fileCount: 0,
      filesIdentity: `sha256:${'0'.repeat(64)}`,
    },
    planes: [
      {
        kind: 'inventory',
        required: true,
        status: 'rebuilt',
        producer: {
          toolId: GRAPH_TOOL_ID,
          command: INVENTORY_COMMAND,
          version: '1.0.0',
        },
        pointer: {
          owner: 'graph',
          kind: 'inventory',
          id: INVENTORY_ID,
          schemaVersion: 1,
        },
        step: {
          runId,
          stepId: INVENTORY_STEP_ID,
          logicalStepKey: INVENTORY_STEP_KEY,
          ordinal: 0,
          attempt: 1,
        },
        freshness: { status: 'current', reasonCodes: [] },
        coverage: {
          status: 'complete',
          reasonCodes: [],
          observed: 1,
          total: 1,
        },
        caps: { status: 'not-hit', reasonCodes: [] },
        reasonCodes: [],
        followUpReads: ['get_file_context'],
      },
    ],
    reasonCodes: [],
    nextActions: ['get_file_context'],
  };
}

function readyManifest(runId = READY_RUN_ID): TaskContextManifest {
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-12T00:00:00.500Z',
    projectIdentity: buildTaskContextProjectIdentity('/repo'),
    readiness: 'ready',
    sourceStart: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: CLEAN_WORKTREE_ID,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: CLEAN_WORKTREE_ID,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    fileScope: {
      mode: 'explicit',
      fileCount: 1,
      filesIdentity: `sha256:${'4'.repeat(64)}`,
    },
    graphIdentity: GRAPH_ID,
    inventoryIdentity: INVENTORY_ID,
    planes: authorities.map((authority, ordinal) => ({
      kind: authority.kind,
      required: true,
      status: 'rebuilt',
      producer: {
        toolId: GRAPH_TOOL_ID,
        command: authority.command,
        version: '1.0.0',
      },
      pointer: {
        owner: 'graph',
        kind: authority.kind,
        id: authority.id,
        schemaVersion: authority.schemaVersion,
      },
      step: {
        runId,
        stepId: fixtureId('STEP', `step-${authority.kind}`),
        logicalStepKey: `${String(ordinal)}:${GRAPH_TOOL_ID}:${authority.command}`,
        ordinal,
        attempt: 1,
      },
      freshness: { status: 'current', reasonCodes: [] },
      coverage: { status: 'complete', reasonCodes: [], observed: 1, total: 1 },
      caps: { status: 'not-hit', reasonCodes: [] },
      reasonCodes: [],
      followUpReads: [],
    })),
    reasonCodes: [],
    nextActions: ['get_context_status'],
  };
}

function readySteps(runId = READY_RUN_ID): StoredRunStep[] {
  return authorities.map((authority, ordinal) => ({
    id: fixtureId('STEP', `step-${authority.kind}`),
    runId,
    logicalStepKey: `${String(ordinal)}:${GRAPH_TOOL_ID}:${authority.command}`,
    ordinal,
    attempt: 1,
    tool: 'graph',
    command: authority.command,
    stableId: GRAPH_TOOL_ID,
    exitCode: 0,
    outcome: 'passed',
    durationMs: 1,
    evidence: {
      kind: 'evidence-snapshots',
      schemaVersion: 1,
      snapshots: [
        {
          kind: authority.kind,
          status: 'rebuilt',
          snapshotId: authority.id,
          snapshotSchemaVersion: authority.schemaVersion,
          producer: {
            toolId: GRAPH_TOOL_ID,
            command: authority.command,
            version: '1.0.0',
          },
          freshness: { status: 'current', reasonCodes: [] },
          coverage: { status: 'complete', items: 1, total: 1, reasonCodes: [] },
          ...(authority.kind === 'test-selection'
            ? {
                inputs: [
                  { kind: 'inventory', snapshotId: INVENTORY_ID },
                  { kind: 'graph', snapshotId: GRAPH_ID },
                ],
              }
            : {}),
          reasonCodes: [],
          followUpReads: [],
        },
      ],
    },
  }));
}

function readyRun(
  contextManifest: TaskContextManifest = readyManifest(),
  overrides: Partial<StoredRun> = {},
): StoredRun {
  return run({
    id: contextManifest.runId,
    durationMs: 1000.25,
    exitCode: 0,
    aggregate: {
      steps: 3,
      passed: 3,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    contextManifest,
    ...overrides,
  });
}

function evidenceSnapshot(stepValue: StoredRunStep): Record<string, unknown> {
  const evidence = stepValue.evidence as { snapshots?: unknown[] } | undefined;
  const snapshot = evidence?.snapshots?.[0];
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('test fixture evidence snapshot is missing');
  }
  return snapshot as Record<string, unknown>;
}

function run(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: DEFAULT_RUN_ID,
    name: 'agent-context',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 1,
    aggregate: {
      steps: 3,
      passed: 1,
      failed: 0,
      faulted: 2,
      errors: 0,
      warnings: 0,
    },
    contextManifest: manifest(),
    ...overrides,
  };
}

function insertRawManifest(store: DataStore, id: string, contextManifest: unknown): void {
  requireDrizzleHandle(store)
    .db.insert(runs)
    .values({
      id,
      name: 'agent-context',
      source: 'built-in-suite',
      cwd: '/repo',
      started_at: 1,
      started_at_iso: '1970-01-01T00:00:00.001Z',
      completed_at: 2,
      completed_at_iso: '1970-01-01T00:00:00.002Z',
      duration_ms: 1,
      exit_code: 1,
      aggregate: {
        steps: 0,
        passed: 0,
        failed: 0,
        faulted: 1,
        errors: 0,
        warnings: 0,
      },
      context_manifest: contextManifest,
    })
    .run();
}

describe('readTaskContextRun', () => {
  it('reads the latest exact project/name Run and validates step references', () => {
    const store = open();
    new RunRepo(store).saveRunWithSteps(run(), unavailableSteps());
    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.run.id).toBe(DEFAULT_RUN_ID);
      expect(result.value.steps.map((value) => value.id)).toEqual([
        INVENTORY_STEP_ID,
        fixtureId('STEP', 'step-graph'),
        fixtureId('STEP', 'step-test-selection'),
      ]);
    }
  });

  it('accepts a complete ready manifest only when all three evidence rows match', () => {
    const store = open();
    const contextManifest = readyManifest();
    new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), readySteps());

    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.readiness).toBe('ready');
      expect(result.value.steps).toHaveLength(3);
    }
  });

  it('rejects a ready manifest even when faulted rows and aggregate agree with each other', () => {
    const store = open();
    const contextManifest = readyManifest();
    const steps = structuredClone(readySteps()).map((step): StoredRunStep => {
      if (typeof step.evidence !== 'object' || step.evidence === null) {
        throw new TypeError('ready fixture evidence is missing');
      }
      const evidence = step.evidence as Record<string, unknown>;
      if (evidence.kind !== 'evidence-snapshots' || !Array.isArray(evidence.snapshots)) {
        throw new TypeError('ready fixture evidence is malformed');
      }
      return {
        ...step,
        outcome: 'faulted',
        exitCode: 1,
        evidence: {
          ...evidence,
          snapshots: evidence.snapshots.map((snapshot: unknown) => {
            if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
              throw new TypeError('ready fixture evidence snapshot is malformed');
            }
            return { ...(snapshot as Record<string, unknown>), status: 'failed' };
          }),
        },
      };
    });
    new RunRepo(store).saveRunWithSteps(
      readyRun(contextManifest, {
        exitCode: 1,
        aggregate: {
          steps: 3,
          passed: 0,
          failed: 0,
          faulted: 3,
          errors: 0,
          warnings: 0,
        },
      }),
      steps,
    );
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('replays a degraded manifest whose source-drift reason is host-derived', () => {
    const store = open();
    const base = readyManifest(fixtureId('RUN', 'run-drifted'));
    const contextManifest = {
      ...base,
      readiness: 'degraded',
      sourceEnd: {
        ...base.sourceEnd,
        worktreeIdentity: DIRTY_WORKTREE_ID,
        dirty: true,
      },
      planes: base.planes.map((plane) => ({
        ...plane,
        reasonCodes: ['source-drift'],
      })),
      reasonCodes: ['source-drift'],
      nextActions: ['opensip suite run agent-context --files <same-explicit-files> --json'],
    } as TaskContextManifest;
    new RunRepo(store).saveRunWithSteps(
      readyRun(contextManifest),
      readySteps(contextManifest.runId),
    );

    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.manifest.readiness).toBe('degraded');
  });

  it('rejects configured-suite authority and corrupted producer step fields', () => {
    const configuredStore = open();
    const contextManifest = readyManifest();
    new RunRepo(configuredStore).saveRunWithSteps(
      readyRun(contextManifest, { source: 'configured-suite' }),
      readySteps(),
    );
    expect(
      readTaskContextRun({
        datastore: configuredStore,
        cwd: '/repo',
        runId: contextManifest.runId,
      }),
    ).toMatchObject({ ok: false, error: { reason: 'wrong-run-kind' } });

    const mutations: readonly ((steps: StoredRunStep[]) => void)[] = [
      (steps) => {
        steps[0] = { ...steps[0], stableId: 'spoofed-graph' };
      },
      (steps) => {
        steps[0] = { ...steps[0], command: 'spoofed-command' };
      },
      (steps) => {
        steps[0] = { ...steps[0], ordinal: 9 };
      },
      (steps) => {
        steps[0] = { ...steps[0], logicalStepKey: '0:spoofed:command' };
      },
    ];
    for (const mutate of mutations) {
      const store = open();
      const steps = structuredClone(readySteps());
      mutate(steps);
      new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), steps);
      expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
        ok: false,
        error: { reason: 'invalid-manifest' },
      });
    }
  });

  it('does not let a configured suite with the reserved name shadow built-in context', () => {
    const store = open();
    const repo = new RunRepo(store);
    const contextManifest = readyManifest();
    repo.saveRunWithSteps(readyRun(contextManifest), readySteps());
    repo.saveRun(
      run({
        id: 'configured-agent-context',
        source: 'configured-suite',
        contextManifest: undefined,
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:00:01.000Z',
      }),
    );

    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.run.id).toBe(contextManifest.runId);
  });

  it('rejects reused step references and evidence pointer or input mismatches', () => {
    const base = readyManifest();
    const reusedStepManifest = {
      ...base,
      planes: base.planes.map((plane, index) =>
        index === 1 ? { ...plane, step: base.planes[0].step } : plane,
      ),
    } as TaskContextManifest;
    const reusedStore = open();
    new RunRepo(reusedStore).saveRunWithSteps(readyRun(reusedStepManifest), readySteps());
    expect(readTaskContextRun({ datastore: reusedStore, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });

    const pointerStore = open();
    const pointerSteps = structuredClone(readySteps());
    evidenceSnapshot(pointerSteps[0]).snapshotId = `i1:${'9'.repeat(64)}`;
    new RunRepo(pointerStore).saveRunWithSteps(readyRun(base), pointerSteps);
    expect(readTaskContextRun({ datastore: pointerStore, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });

    const inputStore = open();
    const inputSteps = structuredClone(readySteps());
    evidenceSnapshot(inputSteps[2]).inputs = [
      { kind: 'inventory', snapshotId: INVENTORY_ID },
      { kind: 'graph', snapshotId: `g1:${'8'.repeat(64)}` },
    ];
    new RunRepo(inputStore).saveRunWithSteps(readyRun(base), inputSteps);
    expect(readTaskContextRun({ datastore: inputStore, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('rejects missing, ambiguous, or status-divergent stored evidence', () => {
    const mutations: readonly ((steps: StoredRunStep[]) => void)[] = [
      (steps) => {
        steps[0] = { ...steps[0], evidence: undefined };
      },
      (steps) => {
        const evidence = steps[0].evidence as { snapshots: unknown[] };
        steps[0] = {
          ...steps[0],
          evidence: {
            ...evidence,
            snapshots: [...evidence.snapshots, evidence.snapshots[0]],
          },
        };
      },
      (steps) => {
        evidenceSnapshot(steps[0]).status = 'partial';
      },
    ];
    for (const mutate of mutations) {
      const store = open();
      const contextManifest = readyManifest();
      const steps = structuredClone(readySteps());
      mutate(steps);
      new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), steps);
      expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
        ok: false,
        error: { reason: 'invalid-manifest' },
      });
    }
  });

  it('preserves the foreign-project reason without exposing foreign run data', () => {
    const store = open();
    const repo = new RunRepo(store);
    repo.saveRunWithSteps(run(), unavailableSteps());
    const foreign = readTaskContextRun({
      datastore: store,
      cwd: '/other',
      runId: DEFAULT_RUN_ID,
    });
    expect(foreign).toMatchObject({
      ok: false,
      error: { reason: 'foreign-project' },
    });
    expect(JSON.stringify(foreign)).not.toContain('/other');
    expect(JSON.stringify(foreign)).not.toContain(DEFAULT_RUN_ID);
  });

  it('distinguishes pre-feature runs', () => {
    const store = open();
    const repo = new RunRepo(store);
    repo.saveRun(run({ id: 'run-old', contextManifest: undefined }));
    const old = readTaskContextRun({
      datastore: store,
      cwd: '/repo',
      runId: 'run-old',
    });
    expect(old).toMatchObject({ ok: false, error: { reason: 'pre-feature' } });
  });

  it('distinguishes an unsupported persisted manifest version from malformed v1 data', () => {
    const store = open();
    insertRawManifest(store, 'run-future', {
      schemaVersion: 2,
      suite: 'agent-context',
    });
    insertRawManifest(store, 'run-malformed', {
      schemaVersion: 1,
      suite: 'agent-context',
    });

    expect(
      readTaskContextRun({
        datastore: store,
        cwd: '/repo',
        runId: 'run-future',
      }),
    ).toMatchObject({ ok: false, error: { reason: 'unsupported-version' } });
    expect(
      readTaskContextRun({
        datastore: store,
        cwd: '/repo',
        runId: 'run-malformed',
      }),
    ).toMatchObject({ ok: false, error: { reason: 'invalid-manifest' } });
  });

  it('fails closed when a manifest step pointer does not match stored evidence', () => {
    const store = open();
    const broken = manifest();
    const contextManifest = {
      ...broken,
      planes: [
        {
          ...broken.planes[0],
          step: { ...broken.planes[0].step, stepId: 'ghost' },
        },
      ],
    } as TaskContextManifest;
    new RunRepo(store).saveRunWithSteps(run({ contextManifest }), unavailableSteps());
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('rejects a stored manifest bound to a different canonical project identity', () => {
    const store = open();
    const repo = new RunRepo(store);
    const runId = fixtureId('RUN', 'run-project-mismatch');
    repo.saveRunWithSteps(
      run({ id: runId, contextManifest: manifest(runId) }),
      unavailableSteps(runId),
    );
    requireDrizzleHandle(store)
      .db.update(runs)
      .set({
        context_manifest: {
          ...manifest(runId),
          projectIdentity: buildTaskContextProjectIdentity('/another/project'),
        },
      })
      .where(eq(runs.id, runId))
      .run();

    expect(readTaskContextRun({ datastore: store, cwd: '/repo', runId })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('rejects unbounded generic Run metadata instead of replaying cast JSON', () => {
    const store = open();
    const contextManifest = readyManifest();
    new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), readySteps());
    requireDrizzleHandle(store)
      .db.update(runs)
      .set({
        aggregate: {
          steps: 3,
          passed: 3,
          failed: 0,
          faulted: 0,
          errors: 0,
          warnings: 0,
          privatePath: '/private/customer/repo',
        },
      })
      .where(eq(runs.id, contextManifest.runId))
      .run();

    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
    expect(JSON.stringify(result)).not.toContain('/private/customer/repo');
  });

  it("rejects an unbounded ID on an unavailable manifest's unreferenced step", () => {
    const store = open();
    new RunRepo(store).saveRunWithSteps(run(), unavailableSteps());
    const privateId = `private-customer-step-${'x'.repeat(300)}`;
    requireDrizzleHandle(store)
      .db.update(runSteps)
      .set({ id: privateId })
      .where(eq(runSteps.id, fixtureId('STEP', 'step-test-selection')))
      .run();

    const result = readTaskContextRun({ datastore: store, cwd: '/repo' });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
    expect(JSON.stringify(result)).not.toContain(privateId);
  });

  it('derives the aggregate from bounded authoritative step outcomes and verdicts', () => {
    const aggregateStore = open();
    const contextManifest = readyManifest();
    new RunRepo(aggregateStore).saveRunWithSteps(
      readyRun(contextManifest, {
        aggregate: {
          steps: 3,
          passed: 0,
          failed: 0,
          faulted: 3,
          errors: 0,
          warnings: 0,
        },
      }),
      readySteps(),
    );
    expect(readTaskContextRun({ datastore: aggregateStore, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });

    const corruptions: readonly ((steps: StoredRunStep[]) => void)[] = [
      (steps) => {
        steps[0] = {
          ...steps[0],
          outcome: 'invented',
        } as unknown as StoredRunStep;
      },
      (steps) => {
        steps[0] = { ...steps[0], exitCode: -1 };
      },
      (steps) => {
        steps[0] = { ...steps[0], exitCode: 99 };
      },
      (steps) => {
        steps[0] = { ...steps[0], durationMs: -1 };
      },
      (steps) => {
        steps[0] = {
          ...steps[0],
          verdictSummary: {
            passed: true,
            errors: 1,
            warnings: 0,
            findings: 1,
          },
        };
      },
      (steps) => {
        steps[0] = {
          ...steps[0],
          verdictSummary: {
            passed: true,
            errors: -1,
            warnings: 0,
            findings: 0,
          },
        };
      },
    ];
    for (const corrupt of corruptions) {
      const store = open();
      const steps = structuredClone(readySteps());
      new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), steps);
      corrupt(steps);
      const corrupted = steps[0];
      if (corrupted === undefined) throw new TypeError('missing corruption fixture step');
      // Preparation now rejects malformed required row fields before acquiring
      // a write lock. Poison the durable row directly so this reader-hardening
      // test still exercises legacy/hand-edited SQLite corruption.
      requireDrizzleHandle(store)
        .db.update(runSteps)
        .set({
          exit_code: corrupted.exitCode,
          outcome: corrupted.outcome,
          duration_ms: corrupted.durationMs,
          verdict_summary: corrupted.verdictSummary ?? null,
        })
        .where(eq(runSteps.id, corrupted.id))
        .run();
      expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
        ok: false,
        error: { reason: 'invalid-manifest' },
      });
    }
  });

  it('rejects a noncanonical parent exit even when all other authority matches', () => {
    const store = open();
    const contextManifest = readyManifest();
    new RunRepo(store).saveRunWithSteps(readyRun(contextManifest, { exitCode: 99 }), readySteps());
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('rejects a manifest creation time outside the host-owned run interval', () => {
    const store = open();
    const contextManifest = {
      ...readyManifest(),
      createdAt: '2026-07-12T00:00:02.000Z',
    } as TaskContextManifest;
    new RunRepo(store).saveRunWithSteps(readyRun(contextManifest), readySteps());
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid-manifest' },
    });
  });

  it('returns missing when no agent-context run exists for the project', () => {
    const store = open();
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'missing' },
    });
    expect(
      readTaskContextRun({ datastore: store, cwd: '/repo', runId: 'RUN_DOES_NOT_EXIST' }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'missing' },
    });
  });

  it('rejects a non-agent-context run kind by name', () => {
    const store = open();
    const contextManifest = readyManifest();
    new RunRepo(store).saveRunWithSteps(readyRun(contextManifest, { name: 'audit' }), readySteps());
    expect(
      readTaskContextRun({
        datastore: store,
        cwd: '/repo',
        runId: contextManifest.runId,
      }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'wrong-run-kind' },
    });
  });

  it('fails closed when datastore reads throw', () => {
    const store = open();
    const handle = requireDrizzleHandle(store);
    vi.spyOn(handle.db, 'select').mockImplementation(() => {
      throw new Error('db-offline');
    });
    expect(readTaskContextRun({ datastore: store, cwd: '/repo' })).toMatchObject({
      ok: false,
      error: { reason: 'storage-failed' },
    });
  });
});
