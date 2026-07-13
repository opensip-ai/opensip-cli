import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskContextFileScope, buildTaskContextProjectIdentity } from '@opensip-cli/contracts';
import { err, ok } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { RunRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SqliteContextReadPort } from '../sqlite-context-read-port.js';

import type { CodebaseReadPort } from '../codebase-read-port.js';
import type { GraphReadPort } from '../graph-read-port.js';
import type {
  StoredRun,
  StoredRunStep,
  TaskContextManifest,
  TaskContextSnapshotPointer,
} from '@opensip-cli/contracts';

let store: DataStore;
let root: string;
const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
const GRAPH_ID = `g1:${'1'.repeat(64)}`;
const INVENTORY_ID = `i1:${'2'.repeat(64)}`;
const REPLACEMENT_INVENTORY_ID = `i1:${'3'.repeat(64)}`;
const CONFIG_ID = `sha256:${'4'.repeat(64)}`;

function ledgerId(prefix: 'RUN' | 'STEP', value: string): string {
  if (new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'u').test(value)) return value;
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 26).toUpperCase()}`;
}

const CONTEXT_RUN_ID = ledgerId('RUN', 'context-run');
const INVENTORY_STEP_ID = ledgerId('STEP', 'inventory-step');
const GRAPH_STEP_ID = ledgerId('STEP', 'context-step');
const SELECTION_STEP_ID = ledgerId('STEP', 'selection-step');

beforeEach(() => {
  store = DataStoreFactory.open({ backend: 'memory' });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-context-read-')));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function manifest(
  runId = CONTEXT_RUN_ID,
  withInventory = false,
  projectIdentity = buildTaskContextProjectIdentity(root),
): TaskContextManifest {
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-13T00:00:00.000Z',
    projectIdentity,
    readiness: 'unavailable',
    sourceStart: {
      configIdentity: CONFIG_ID,
      status: 'unsupported',
      reasonCodes: ['git-unavailable'],
    },
    sourceEnd: {
      configIdentity: CONFIG_ID,
      status: 'unsupported',
      reasonCodes: ['git-unavailable'],
    },
    fileScope: buildTaskContextFileScope(['src/task.ts']),
    graphIdentity: GRAPH_ID,
    ...(withInventory ? { inventoryIdentity: INVENTORY_ID } : {}),
    planes: [
      ...(withInventory
        ? [
            {
              kind: 'inventory',
              required: true,
              status: 'reused' as const,
              producer: {
                toolId: GRAPH_TOOL_ID,
                command: 'graph-context-inventory',
                version: '1.0.0',
              },
              pointer: {
                owner: 'graph' as const,
                kind: 'inventory' as const,
                id: INVENTORY_ID,
                schemaVersion: 1,
              },
              step: {
                runId,
                stepId: INVENTORY_STEP_ID,
                logicalStepKey: `0:${GRAPH_TOOL_ID}:graph-context-inventory`,
                ordinal: 0,
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
              followUpReads: ['get_file_context'],
            } satisfies TaskContextManifest['planes'][number],
          ]
        : []),
      {
        kind: 'graph',
        required: true,
        status: 'reused',
        producer: {
          toolId: GRAPH_TOOL_ID,
          command: 'graph-context-ensure',
          version: '1.0.0',
        },
        pointer: {
          owner: 'graph',
          kind: 'graph',
          id: GRAPH_ID,
          schemaVersion: 3,
        },
        step: {
          runId,
          stepId: GRAPH_STEP_ID,
          logicalStepKey: `1:${GRAPH_TOOL_ID}:graph-context-ensure`,
          ordinal: 1,
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
        followUpReads: ['get_context_status'],
      } satisfies TaskContextManifest['planes'][number],
    ],
    reasonCodes: [],
    nextActions: [],
  };
}

function codebase(identity = INVENTORY_ID): CodebaseReadPort {
  return {
    inventoryStatus: () =>
      Promise.resolve(
        ok({
          identity,
          freshness: {
            fresh: true,
            capturedAt: '2026-07-13T00:00:00.000Z',
            verification: 'complete',
            reasonCodes: [],
          },
        } as never),
      ),
  } as unknown as CodebaseReadPort;
}

function failingCodebase(): CodebaseReadPort {
  return {
    inventoryStatus: () =>
      Promise.resolve(
        err({
          code: 'inventory-read-failed',
          message: 'private inventory failure',
        }),
      ),
  } as unknown as CodebaseReadPort;
}

function seed(runId = CONTEXT_RUN_ID, cwd = root, withInventory = false): void {
  runId = ledgerId('RUN', runId);
  const contextManifest = manifest(runId, withInventory, buildTaskContextProjectIdentity(cwd));
  const run: StoredRun = {
    id: runId,
    name: 'agent-context',
    source: 'built-in-suite',
    cwd,
    startedAt: '2026-07-13T00:00:00.000Z',
    completedAt: '2026-07-13T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 1,
    aggregate: {
      steps: 3,
      passed: withInventory ? 2 : 1,
      failed: 0,
      faulted: withInventory ? 1 : 2,
      errors: 0,
      warnings: 0,
    },
    contextManifest,
  };
  const graphStep: StoredRunStep = {
    id: GRAPH_STEP_ID,
    runId,
    logicalStepKey: `1:${GRAPH_TOOL_ID}:graph-context-ensure`,
    ordinal: 1,
    attempt: 1,
    tool: 'graph',
    command: 'graph-context-ensure',
    stableId: GRAPH_TOOL_ID,
    exitCode: 0,
    outcome: 'passed',
    durationMs: 50,
    evidence: {
      kind: 'evidence-snapshots',
      schemaVersion: 1,
      snapshots: [
        {
          kind: 'graph',
          status: 'reused',
          snapshotId: GRAPH_ID,
          snapshotSchemaVersion: 3,
          producer: {
            toolId: GRAPH_TOOL_ID,
            command: 'graph-context-ensure',
            version: '1.0.0',
          },
          freshness: { status: 'current', reasonCodes: [] },
          coverage: { status: 'complete', items: 1, total: 1, reasonCodes: [] },
          reasonCodes: [],
          followUpReads: ['get_context_status'],
        },
      ],
    },
  };
  const inventoryStep: StoredRunStep = {
    id: INVENTORY_STEP_ID,
    runId,
    logicalStepKey: `0:${GRAPH_TOOL_ID}:graph-context-inventory`,
    ordinal: 0,
    attempt: 1,
    tool: 'graph',
    command: 'graph-context-inventory',
    stableId: GRAPH_TOOL_ID,
    exitCode: withInventory ? 0 : 1,
    outcome: withInventory ? 'passed' : 'faulted',
    durationMs: 25,
    ...(withInventory
      ? {
          evidence: {
            kind: 'evidence-snapshots',
            schemaVersion: 1,
            snapshots: [
              {
                kind: 'inventory',
                status: 'reused',
                snapshotId: INVENTORY_ID,
                snapshotSchemaVersion: 1,
                producer: {
                  toolId: GRAPH_TOOL_ID,
                  command: 'graph-context-inventory',
                  version: '1.0.0',
                },
                freshness: { status: 'current', reasonCodes: [] },
                coverage: {
                  status: 'complete',
                  items: 1,
                  total: 1,
                  reasonCodes: [],
                },
                reasonCodes: [],
                followUpReads: ['get_file_context'],
              },
            ],
          },
        }
      : {}),
  };
  const selectionStep: StoredRunStep = {
    id: SELECTION_STEP_ID,
    runId,
    logicalStepKey: `2:${GRAPH_TOOL_ID}:graph-context-select-tests`,
    ordinal: 2,
    attempt: 1,
    tool: 'graph',
    command: 'graph-context-select-tests',
    stableId: GRAPH_TOOL_ID,
    exitCode: 1,
    outcome: 'faulted',
    durationMs: 10,
  };
  new RunRepo(store).saveRunWithSteps(run, [inventoryStep, graphStep, selectionStep]);
}

describe('SqliteContextReadPort', () => {
  it('replays the recorded parent Run and checks the exact pointer', async () => {
    seed();
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    );
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: codebase(),
    });
    const result = await port.contextStatus({
      runId: CONTEXT_RUN_ID,
      files: ['src/task.ts'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contextPointerStatus).toHaveBeenCalledWith(
      { owner: 'graph', kind: 'graph', id: GRAPH_ID, schemaVersion: 3 },
      undefined,
      { forceFresh: true },
    );
    expect(result.value).toMatchObject({
      status: 'available',
      run: { id: CONTEXT_RUN_ID, name: 'agent-context' },
      manifest: { graphIdentity: GRAPH_ID },
      fileScope: {
        status: 'matched',
        requested: { mode: 'explicit', fileCount: 1 },
        recorded: { mode: 'explicit', fileCount: 1 },
      },
      pointers: [{ status: 'available', pointer: { id: GRAPH_ID } }],
      steps: [
        { runId: CONTEXT_RUN_ID, stepId: INVENTORY_STEP_ID },
        { runId: CONTEXT_RUN_ID, stepId: GRAPH_STEP_ID },
        { runId: CONTEXT_RUN_ID, stepId: SELECTION_STEP_ID },
      ],
    });
  });

  it('returns a conservative rerun action when no context Run exists', async () => {
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: {} as GraphReadPort,
      codebase: codebase(),
    });
    const result = await port.contextStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('missing');
    expect(result.value.fileScope.status).toBe('not-requested');
    expect(result.value.nextActions.join(' ')).toContain('agent-context');
  });

  it('keeps an exact inventory pointer available when it matches the current inventory', async () => {
    seed(CONTEXT_RUN_ID, root, true);
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    );
    const inventoryStatus = vi.fn(() => codebase().inventoryStatus());
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: { inventoryStatus } as unknown as CodebaseReadPort,
    });

    const result = await port.contextStatus({ runId: CONTEXT_RUN_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inventoryStatus).toHaveBeenCalledTimes(1);
    expect(inventoryStatus).toHaveBeenCalledWith(undefined, {
      forceFresh: true,
    });
    expect(result.value.pointers).toContainEqual({
      pointer: {
        owner: 'graph',
        kind: 'inventory',
        id: INVENTORY_ID,
        schemaVersion: 1,
      },
      status: 'available',
      reasonCodes: [],
    });
  });

  it('marks a retained inventory pointer stale without exposing or rebinding its replacement', async () => {
    seed(CONTEXT_RUN_ID, root, true);
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    );
    const replacement = REPLACEMENT_INVENTORY_ID;
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: codebase(replacement),
    });

    const result = await port.contextStatus({ runId: CONTEXT_RUN_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pointers).toContainEqual({
      pointer: {
        owner: 'graph',
        kind: 'inventory',
        id: INVENTORY_ID,
        schemaVersion: 1,
      },
      status: 'stale',
      reasonCodes: ['inventory-snapshot-not-current'],
    });
    expect(result.value.reasonCodes).toContain('inventory-snapshot-not-current');
    expect(JSON.stringify(result.value)).not.toContain(replacement);
  });

  it('qualifies an inventory freshness read failure instead of failing exact Run replay', async () => {
    seed(CONTEXT_RUN_ID, root, true);
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    );
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: failingCodebase(),
    });

    const result = await port.contextStatus({ runId: CONTEXT_RUN_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pointers).toContainEqual({
      pointer: {
        owner: 'graph',
        kind: 'inventory',
        id: INVENTORY_ID,
        schemaVersion: 1,
      },
      status: 'stale',
      reasonCodes: ['inventory-freshness-verification-failed'],
    });
    expect(JSON.stringify(result.value)).not.toContain('private inventory failure');
  });

  it('reports a privacy-safe mismatch and preserves the same explicit scope rerun', async () => {
    seed();
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    );
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: codebase(),
    });
    const requestedPath = 'src/private-customer-task.ts';
    const result = await port.contextStatus({ files: [requestedPath] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileScope).toMatchObject({
      status: 'mismatched',
      requested: { mode: 'explicit', fileCount: 1 },
      recorded: { mode: 'explicit', fileCount: 1 },
    });
    expect(result.value.reasonCodes).toContain('context-scope-mismatch');
    expect(result.value.nextActions.join(' ')).toContain('same explicit --files set');
    expect(JSON.stringify(result.value)).not.toContain(requestedPath);
  });

  it('preserves recorded explicit scope in a stale rerun action when files were not requested', async () => {
    seed();
    const contextPointerStatus = vi.fn((pointer: TaskContextSnapshotPointer) =>
      Promise.resolve(
        ok({
          pointer,
          status: 'stale' as const,
          reasonCodes: ['pointer-stale'],
        }),
      ),
    );
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: { contextPointerStatus } as unknown as GraphReadPort,
      codebase: codebase(),
    });
    const result = await port.contextStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileScope.status).toBe('not-requested');
    expect(result.value.nextActions.join(' ')).toContain('same explicit --files set');
  });

  it('marks requested explicit scope mismatched when no context Run exists', async () => {
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: {} as GraphReadPort,
      codebase: codebase(),
    });
    const result = await port.contextStatus({ files: ['src/task.ts'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      status: 'missing',
      fileScope: {
        status: 'mismatched',
        requested: { mode: 'explicit', fileCount: 1 },
      },
      reasonCodes: ['context-run-missing', 'context-scope-mismatch'],
    });
    expect(result.value.nextActions.join(' ')).toContain('same explicit --files set');
  });

  it('does not disclose an exact Run from another project', async () => {
    const foreignRunId = ledgerId('RUN', 'foreign-run');
    seed(foreignRunId, '/another-project');
    const port = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph: {} as GraphReadPort,
      codebase: codebase(),
    });
    const result = await port.contextStatus({ runId: foreignRunId });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'context-run-foreign-project' },
    });
    expect(JSON.stringify(result)).not.toContain(foreignRunId);
    expect(JSON.stringify(result)).not.toContain('/another-project');
  });
});
