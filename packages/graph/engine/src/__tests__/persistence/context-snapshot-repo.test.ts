import { createHash } from 'node:crypto';

import {
  buildProjectInventorySnapshotIdentities,
  buildTestSelectionSnapshotIdentity,
  buildTaskContextProjectIdentity,
  projectInventorySnapshotSchema,
} from '@opensip-cli/contracts';
import { RunScope, logger, normalizeFailure, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { readTaskContextRun, RunRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContextRunState } from '../../context-run-state.js';
import {
  ContextSnapshotRepo,
  MAX_CONTEXT_SNAPSHOT_PAYLOAD_BYTES,
  MAX_CONTEXT_SNAPSHOTS_PER_KIND,
  MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES,
  createContextSnapshotAccessor,
} from '../../persistence/context-snapshot-repo.js';
import { graphContextSnapshot } from '../../persistence/schema.js';
import { readContextSnapshot } from '../../read/context-snapshot.js';

import type { ContextSnapshotSaveInput } from '../../read/context-snapshot.js';
import type {
  ProjectInventorySnapshot,
  StoredRun,
  StoredRunStep,
  TaskContextManifest,
  TestSelectionSnapshot,
} from '@opensip-cli/contracts';

const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inventoryId(value: string): string {
  return inventory(value).snapshotId;
}

function ledgerId(prefix: 'RUN' | 'STEP', value: string): string {
  return `${prefix}_${digest(value).slice(0, 26).toUpperCase()}`;
}

function identifyInventory(
  input: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'>,
): ProjectInventorySnapshot {
  return { ...input, ...buildProjectInventorySnapshotIdentities(input) };
}

function inventory(id: string, metadataMarker = `metadata:${id}`): ProjectInventorySnapshot {
  return identifyInventory({
    schemaVersion: 1,
    project: {
      workspacePatterns: [],
      languages: [],
      fileCount: 0,
      packageCount: 0,
      configIdentity: `config:${metadataMarker}`,
    },
    packages: [],
    files: [],
    coverage: { status: 'complete', reasonCodes: [], observed: 0, total: 0 },
  });
}

function input(id: string, createdAt: string) {
  const payload = inventory(id);
  return {
    id: payload.snapshotId,
    kind: 'inventory' as const,
    schemaVersion: 1,
    producerVersion: '0.6.0',
    createdAt,
    sourceIdentity: `metadata:${id}`,
    configIdentity: 'config:1',
    payload,
  };
}

function selection(id: string, proofLength = 0): TestSelectionSnapshot {
  const withoutId: Omit<TestSelectionSnapshot, 'snapshotId'> = {
    schemaVersion: 1,
    files: [`src/${id}.ts`],
    tests: Array.from({ length: proofLength === 0 ? 0 : 200 }, (_value, index) => ({
      path: `test/${String(index).padStart(3, '0')}.test.ts`,
      basis: 'direct-call',
      confidence: 'exact',
      proof: [`p${'x'.repeat(proofLength - 1)}`],
      observed: false,
    })),
    commands: [],
    uncoveredFiles: [],
    trust: { status: 'complete', reasonCodes: [], fallbackTier: 'focused' },
    graphIdentity: `g1:${digest('graph:1')}`,
    inventoryIdentity: inventoryId('inventory:1'),
  };
  return {
    ...withoutId,
    snapshotId: buildTestSelectionSnapshotIdentity(withoutId),
  };
}

function largeInventory(id: string, pathPadding = 225): ProjectInventorySnapshot {
  const base = inventory(id);
  return identifyInventory({
    schemaVersion: 1,
    project: {
      ...base.project,
      fileCount: 20_000,
    },
    files: Array.from({ length: 20_000 }, (_value, index) => ({
      path: `src/${String(index).padStart(5, '0')}-${'x'.repeat(pathPadding)}.ts`,
      size: 1,
      modifiedMs: 1,
      roles: [],
      targets: [],
      languages: [],
      evidenceSupport: {
        callable: 'unknown',
        declaration: 'unknown',
        reference: 'unknown',
      },
      provenance: [],
    })),
    coverage: {
      status: 'complete',
      reasonCodes: [],
      observed: 20_000,
      total: 20_000,
    },
    packages: [],
  });
}

function snapshotInput(
  payload: ProjectInventorySnapshot | TestSelectionSnapshot,
  createdAt: string,
): ContextSnapshotSaveInput {
  const kind = 'packages' in payload ? 'inventory' : 'test-selection';
  return {
    id: payload.snapshotId,
    kind,
    schemaVersion: 1,
    producerVersion: '0.6.0',
    createdAt,
    sourceIdentity: `source:${payload.snapshotId}`,
    configIdentity: 'config:1',
    payload,
  };
}

function contextSteps(runId: string, snapshotId: string): StoredRunStep[] {
  return [
    {
      id: ledgerId('STEP', 'step-inventory'),
      runId,
      logicalStepKey: `0:${GRAPH_TOOL_ID}:graph-context-inventory`,
      ordinal: 0,
      attempt: 1,
      tool: 'graph',
      command: 'graph-context-inventory',
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
            snapshotId,
            snapshotSchemaVersion: 1,
            producer: {
              toolId: GRAPH_TOOL_ID,
              command: 'graph-context-inventory',
              version: '0.6.0',
            },
            freshness: { status: 'current', reasonCodes: [] },
            coverage: {
              status: 'complete',
              items: 0,
              total: 0,
              reasonCodes: [],
            },
            reasonCodes: [],
            followUpReads: ['get_file_context'],
          },
        ],
      },
    },
    ...[
      { command: 'graph-context-ensure', kind: 'graph' },
      { command: 'graph-context-select-tests', kind: 'test-selection' },
    ].map(({ command, kind }, index): StoredRunStep => {
      const ordinal = index + 1;
      return {
        id: ledgerId('STEP', `step-${kind}`),
        runId,
        logicalStepKey: `${String(ordinal)}:${GRAPH_TOOL_ID}:${command}`,
        ordinal,
        attempt: 1,
        tool: 'graph',
        command,
        stableId: GRAPH_TOOL_ID,
        exitCode: 1,
        outcome: 'faulted',
        durationMs: 1,
      };
    }),
  ];
}

function contextRun(runId: string, snapshotId: string): StoredRun {
  const manifest: TaskContextManifest = {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-13T00:00:00.500Z',
    projectIdentity: buildTaskContextProjectIdentity('/repo'),
    readiness: 'unavailable',
    sourceStart: {
      configIdentity: `sha256:${digest('config:1')}`,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${digest('worktree:clean')}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: `sha256:${digest('config:1')}`,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${digest('worktree:clean')}`,
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
          command: 'graph-context-inventory',
          version: '0.6.0',
        },
        pointer: {
          owner: 'graph',
          kind: 'inventory',
          id: snapshotId,
          schemaVersion: 1,
        },
        step: {
          runId,
          stepId: ledgerId('STEP', 'step-inventory'),
          logicalStepKey: `0:${GRAPH_TOOL_ID}:graph-context-inventory`,
          ordinal: 0,
          attempt: 1,
        },
        freshness: { status: 'current', reasonCodes: [] },
        coverage: {
          status: 'complete',
          reasonCodes: [],
          observed: 0,
          total: 0,
        },
        caps: { status: 'not-hit', reasonCodes: [] },
        reasonCodes: [],
        followUpReads: ['get_file_context'],
      },
    ],
    reasonCodes: [],
    nextActions: ['get_file_context'],
  };
  return {
    id: runId,
    name: 'agent-context',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: '2026-07-13T00:00:00.000Z',
    completedAt: '2026-07-13T00:00:01.000Z',
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
    contextManifest: manifest,
  };
}

let datastore: DataStore;
let repo: ContextSnapshotRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new ContextSnapshotRepo(datastore);
});

afterEach(() => {
  vi.restoreAllMocks();
  datastore.close();
});

describe('ContextSnapshotRepo', () => {
  it('writes once and reuses identical immutable content', () => {
    const first = repo.save(input('inventory-1', '2026-07-13T00:00:00.000Z'));
    const second = repo.save({
      ...input('inventory-1', '2026-07-14T00:00:00.000Z'),
      producerVersion: '0.7.0',
    });
    expect(first.status).toBe('rebuilt');
    expect(second.status).toBe('reused');
    expect(second.snapshot.createdAt).toBe('2026-07-13T00:00:00.000Z');
    expect(second.snapshot.byteCount).toBe(
      Buffer.byteLength(JSON.stringify(inventory('inventory-1')), 'utf8'),
    );
  });

  it('rejects an immutable ID conflict', () => {
    repo.save(input('inventory-1', '2026-07-13T00:00:00.000Z'));
    expect(() =>
      repo.save({
        ...input('inventory-1', '2026-07-13T00:00:00.000Z'),
        sourceIdentity: 'different-source-binding',
      }),
    ).toThrow(/different immutable content/u);
  });

  it('rejects schema-valid inventory and selection payloads whose content IDs were forged', () => {
    const inventoryPayload = inventory('inventory-forged');
    const forgedInventory = {
      ...inventoryPayload,
      project: { ...inventoryPayload.project, configIdentity: 'config:forged' },
    };
    expect(projectInventorySnapshotSchema.safeParse(forgedInventory).success).toBe(true);
    expect(() =>
      repo.save({
        ...snapshotInput(inventoryPayload, '2026-07-13T00:00:00.000Z'),
        payload: forgedInventory,
      }),
    ).toThrow(/payload is malformed/u);

    const selectionPayload = selection('selection-forged');
    const forgedSelection = {
      ...selectionPayload,
      graphIdentity: `g1:${digest('forged-graph')}`,
    };
    expect(() =>
      repo.save({
        ...snapshotInput(selectionPayload, '2026-07-13T00:00:00.000Z'),
        payload: forgedSelection,
      }),
    ).toThrow(/payload is malformed/u);
  });

  it('retains only the newest three snapshots per kind with deterministic ID ties', () => {
    const candidates = Array.from({ length: 4 }, (_value, index) => {
      const seed = `inventory-${String(index + 1)}`;
      return { seed, id: inventoryId(seed) };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const identities = candidates
      .map(({ id }) => id)
      .sort((left, right) => right.localeCompare(left));
    for (const { seed } of candidates) {
      repo.save(input(seed, '2026-07-13T00:00:00.000Z'));
    }
    expect(repo.get(identities[3] ?? '')).toBeNull();
    expect(repo.latest('inventory')?.id).toBe(identities[0]);
    expect(repo.get(identities[2] ?? '')).not.toBeNull();
  });

  it('rejects malformed, unsupported, and oversized candidates before writing', () => {
    expect(() => repo.save(input('inventory-time', '2026-07-13T00:00:00Z'))).toThrow(
      /created time is invalid/u,
    );
    expect(() =>
      repo.save({
        ...input('inventory-version', '2026-07-13T00:00:00.000Z'),
        schemaVersion: 2,
      }),
    ).toThrow(/payload is malformed/u);
    expect(() =>
      repo.save({
        ...input('inventory-malformed', '2026-07-13T00:00:00.000Z'),
        payload: {
          ...inventory('inventory-malformed'),
          files: [{ path: '../escape.ts' }],
        },
      } as unknown as ContextSnapshotSaveInput),
    ).toThrow(/payload is malformed/u);
    expect(() =>
      repo.save({
        ...input('future-kind', '2026-07-13T00:00:00.000Z'),
        kind: 'future-kind',
      } as unknown as ContextSnapshotSaveInput),
    ).toThrow(/kind is unsupported/u);

    const oversized = largeInventory('inventory-oversized', 331);
    expect(projectInventorySnapshotSchema.safeParse(oversized).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(
      MAX_CONTEXT_SNAPSHOT_PAYLOAD_BYTES,
    );
    expect(() => repo.save(snapshotInput(oversized, '2026-07-13T00:00:00.000Z'))).toThrow(
      /exceeds the 8 MiB limit/u,
    );
    expect(repo.latest('inventory')).toBeNull();
  });

  it('prunes total bytes oldest-first after admitting schema-valid near-limit snapshots', () => {
    const payloads = ['inventory-a', 'inventory-b', 'inventory-c'].map((id) => largeInventory(id));
    const inventoryBytes = payloads.map((payload) =>
      Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    );
    expect(Math.max(...inventoryBytes)).toBeLessThanOrEqual(MAX_CONTEXT_SNAPSHOT_PAYLOAD_BYTES);
    expect(inventoryBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(
      MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES,
    );

    for (const payload of payloads) {
      repo.save(snapshotInput(payload, '2026-07-13T00:00:00.000Z'));
    }
    const selectionPayload = selection('selection-z', 1024);
    const selectionBytes = Buffer.byteLength(JSON.stringify(selectionPayload), 'utf8');
    expect(inventoryBytes.reduce((sum, bytes) => sum + bytes, selectionBytes)).toBeGreaterThan(
      MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES,
    );
    repo.save(snapshotInput(selectionPayload, '2026-07-13T00:00:00.000Z'));

    const retainedInventoryIds = payloads
      .map((payload) => payload.snapshotId)
      .sort((left, right) => right.localeCompare(left));
    expect(repo.get(retainedInventoryIds[2] ?? '')).toBeNull();
    expect(repo.get(retainedInventoryIds[0] ?? '')).not.toBeNull();
    expect(repo.get(retainedInventoryIds[1] ?? '')).not.toBeNull();
    expect(repo.get(selectionPayload.snapshotId)?.byteCount).toBe(selectionBytes);
    const rows = requireDrizzleHandle(datastore).db.select().from(graphContextSnapshot).all();
    expect(rows.reduce((sum, row) => sum + row.byteCount, 0)).toBeLessThanOrEqual(
      MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES,
    );
  });

  // Near-limit inventories (~8 MiB × N) are slow under CI load; do not pin a
  // tight per-test timeout — inherit the shared 120s base testTimeout.
  it('retains an old snapshot reused by the in-progress run when a later plane triggers pruning', () => {
    const payloads = ['inventory-protected', 'inventory-newer-a', 'inventory-newer-b'].map((id) =>
      largeInventory(id),
    );
    const [protectedInventory, newerA, newerB] = payloads;
    if (protectedInventory === undefined || newerA === undefined || newerB === undefined) {
      throw new Error('near-limit inventory fixtures were not created');
    }
    repo.save(snapshotInput(protectedInventory, '2026-07-10T00:00:00.000Z'));
    repo.save(snapshotInput(newerA, '2026-07-11T00:00:00.000Z'));
    repo.save(snapshotInput(newerB, '2026-07-12T00:00:00.000Z'));

    const run = createContextRunState();
    const scope = new RunScope({ datastore: () => datastore });
    Object.assign(scope, { graph: { contextRun: run } });
    const accessor = createContextSnapshotAccessor();
    const selectionPayload = selection('selection-current', 1024);

    runWithScopeSync(scope, () => {
      run.beginInventory();
      const reused = accessor.save(snapshotInput(protectedInventory, '2026-07-13T00:00:00.000Z'));
      expect(reused.status).toBe('reused');
      run.completeInventory(reused.snapshot.id);
      accessor.save(snapshotInput(selectionPayload, '2026-07-14T00:00:00.000Z'));
    });

    expect(repo.get(protectedInventory.snapshotId)).not.toBeNull();
    expect(repo.get(selectionPayload.snapshotId)).not.toBeNull();
    expect([repo.get(newerA.snapshotId), repo.get(newerB.snapshotId)]).toContain(null);
    const rows = requireDrizzleHandle(datastore).db.select().from(graphContextSnapshot).all();
    expect(rows.reduce((sum, row) => sum + row.byteCount, 0)).toBeLessThanOrEqual(
      MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES,
    );
  });

  it('eventually prunes an unreferenced orphan through ordinary retention', () => {
    repo.save(input('orphan', '2026-07-10T00:00:00.000Z'));
    for (let index = 1; index <= MAX_CONTEXT_SNAPSHOTS_PER_KIND; index++) {
      repo.save(input(`retained-${String(index)}`, `2026-07-1${String(index)}T00:00:00.000Z`));
    }
    expect(repo.get(inventoryId('orphan'))).toBeNull();
  });

  it('reports an evicted manifest pointer as missing without substituting latest', () => {
    const runId = ledgerId('RUN', 'run-context');
    repo.save(input('referenced', '2026-07-10T00:00:00.000Z'));
    const referencedId = inventoryId('referenced');
    new RunRepo(datastore).saveRunWithSteps(
      contextRun(runId, referencedId),
      contextSteps(runId, referencedId),
    );
    for (let index = 1; index <= MAX_CONTEXT_SNAPSHOTS_PER_KIND; index++) {
      repo.save(input(`newer-${String(index)}`, `2026-07-1${String(index)}T00:00:00.000Z`));
    }

    const parent = readTaskContextRun({ datastore, cwd: '/repo', runId });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const pointer = parent.value.manifest.planes[0]?.pointer;
    expect(pointer?.id).toBe(referencedId);
    expect(repo.latest('inventory')?.id).toBe(
      inventoryId(`newer-${String(MAX_CONTEXT_SNAPSHOTS_PER_KIND)}`),
    );
    expect(readContextSnapshot(datastore, pointer?.id ?? '')).toEqual({
      ok: true,
      value: { status: 'missing', id: referencedId },
    });
  });

  it('emits bounded lifecycle events without snapshot identities or payload data', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const secret = 'private/path/api-token-value';
    const privatePayload = inventory('inventory-secret-id', secret);
    const first = {
      ...input('inventory-secret-id', '2026-07-11T00:00:00.000Z'),
      id: privatePayload.snapshotId,
      sourceIdentity: secret,
      configIdentity: `${secret}/config`,
      payload: privatePayload,
    };

    repo.save(first);
    repo.save({ ...first, producerVersion: '0.7.0' });
    expect(() =>
      repo.save({
        ...first,
        sourceIdentity: `${secret}/conflict`,
      }),
    ).toThrow(/different immutable content/u);
    expect(() =>
      repo.save({
        ...first,
        kind: 'a'.repeat(10_000),
      } as unknown as ContextSnapshotSaveInput),
    ).toThrow(/kind is invalid/u);
    for (let index = 2; index <= 4; index++) {
      repo.save(input(`inventory-${String(index)}`, `2026-07-1${String(index)}T00:00:00.000Z`));
    }

    const events = [...info.mock.calls, ...error.mock.calls].map(([event]) => event);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evt: 'graph.context.snapshot.saved',
          kind: 'inventory',
          schemaVersion: 1,
          byteCount: expect.any(Number),
          durationMs: expect.any(Number),
        }),
        expect.objectContaining({ evt: 'graph.context.snapshot.reused' }),
        expect.objectContaining({
          evt: 'graph.context.snapshot.pruned',
          kind: 'inventory',
          rowsRemoved: 1,
          bytesRemoved: expect.any(Number),
        }),
        expect.objectContaining({
          evt: 'graph.context.snapshot.failed',
          kind: 'inventory',
          schemaVersion: 1,
          durationMs: expect.any(Number),
        }),
      ]),
    );
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('inventory-secret-id');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('conflict');
    expect(logged).not.toContain('a'.repeat(129));
    expect(logged).not.toContain('stack');
  });

  it('serves exact public reads and reports missing without rebinding', () => {
    repo.save(input('inventory-1', '2026-07-13T00:00:00.000Z'));
    expect(readContextSnapshot(datastore, inventoryId('inventory-1'))).toMatchObject({
      ok: true,
      value: {
        status: 'available',
        snapshot: { id: inventoryId('inventory-1') },
      },
    });
    expect(readContextSnapshot(datastore, 'evicted')).toEqual({
      ok: true,
      value: { status: 'missing', id: 'evicted' },
    });
  });

  it('reports an unsupported persisted version explicitly', () => {
    requireDrizzleHandle(datastore)
      .db.insert(graphContextSnapshot)
      .values({
        id: 'future',
        kind: 'inventory',
        schemaVersion: 2,
        producerVersion: '9.0.0',
        createdAt: '2026-07-13T00:00:00.000Z',
        sourceIdentity: 'future',
        configIdentity: 'config:1',
        byteCount: 2,
        payload: {},
      })
      .run();
    expect(readContextSnapshot(datastore, 'future')).toEqual({
      ok: true,
      value: {
        status: 'unsupported-version',
        id: 'future',
        kind: 'inventory',
        schemaVersion: 2,
      },
    });
  });

  it('fails closed on a malformed persisted payload', () => {
    requireDrizzleHandle(datastore)
      .db.insert(graphContextSnapshot)
      .values({
        id: 'malformed',
        kind: 'inventory',
        schemaVersion: 1,
        producerVersion: '0.6.0',
        createdAt: '2026-07-13T00:00:00.000Z',
        sourceIdentity: 'source:1',
        configIdentity: 'config:1',
        byteCount: 2,
        payload: {},
      })
      .run();
    expect(() => repo.get('malformed')).toThrow(
      expect.objectContaining({ code: 'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED' }),
    );
    expect(readContextSnapshot(datastore, 'malformed')).toMatchObject({
      ok: false,
      error: { code: 'context-snapshot' },
    });
  });

  it('fails closed when the stored payload identity differs from the exact row key', () => {
    const payload = inventory('payload-b');
    requireDrizzleHandle(datastore)
      .db.insert(graphContextSnapshot)
      .values({
        id: 'row-a',
        kind: 'inventory',
        schemaVersion: 1,
        producerVersion: '0.6.0',
        createdAt: '2026-07-13T00:00:00.000Z',
        sourceIdentity: 'source:1',
        configIdentity: 'config:1',
        byteCount: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
        payload,
      })
      .run();
    expect(() => repo.get('row-a')).toThrow(
      expect.objectContaining({ code: 'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED' }),
    );
    expect(readContextSnapshot(datastore, 'row-a')).toMatchObject({
      ok: false,
      error: { code: 'context-snapshot' },
    });
  });

  it('fails closed when schema-valid stored content does not match its embedded identity', () => {
    const inventoryPayload = inventory('stored-inventory-forged');
    const forgedInventory = {
      ...inventoryPayload,
      project: { ...inventoryPayload.project, configIdentity: 'config:forged' },
    };
    const selectionPayload = selection('stored-selection-forged');
    const forgedSelection = {
      ...selectionPayload,
      graphIdentity: `g1:${digest('stored-forged-graph')}`,
    };
    const rows = [
      { kind: 'inventory', payload: forgedInventory },
      { kind: 'test-selection', payload: forgedSelection },
    ] as const;
    for (const row of rows) {
      requireDrizzleHandle(datastore)
        .db.insert(graphContextSnapshot)
        .values({
          id: row.payload.snapshotId,
          kind: row.kind,
          schemaVersion: 1,
          producerVersion: '0.6.0',
          createdAt: '2026-07-13T00:00:00.000Z',
          sourceIdentity: 'source:1',
          configIdentity: 'config:1',
          byteCount: Buffer.byteLength(JSON.stringify(row.payload), 'utf8'),
          payload: row.payload,
        })
        .run();
      expect(readContextSnapshot(datastore, row.payload.snapshotId)).toMatchObject({
        ok: false,
        error: { code: 'context-snapshot' },
      });
    }
  });

  it('rejects persisted byte-count drift before returning a direct repository record', () => {
    const payload = inventory('stored-byte-count');
    requireDrizzleHandle(datastore)
      .db.insert(graphContextSnapshot)
      .values({
        id: payload.snapshotId,
        kind: 'inventory',
        schemaVersion: 1,
        producerVersion: '0.6.0',
        createdAt: '2026-07-13T00:00:00.000Z',
        sourceIdentity: 'source:1',
        configIdentity: 'config:1',
        byteCount: 1,
        payload,
      })
      .run();

    try {
      repo.latest('inventory');
      expect.unreachable('malformed persisted byte count must fail closed');
    } catch (error) {
      const failure = normalizeFailure(error);
      expect(failure).toMatchObject({
        known: 'known',
        code: 'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED',
        metadata: { condition: 'byte-count-mismatch' },
      });
    }
  });
});
