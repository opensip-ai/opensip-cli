import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTaskContextFileScope, buildTaskContextProjectIdentity } from '@opensip-cli/contracts';
import { ok } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { RunRepo } from '@opensip-cli/session-store';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalCodebaseReadPort } from '../local-codebase-read-port.js';
import { SqliteContextReadPort } from '../sqlite-context-read-port.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { StoredRun, StoredRunStep, TaskContextManifest } from '@opensip-cli/contracts';
import type { TargetResolver, TargetView } from '@opensip-cli/core';

const roots: string[] = [];
const stores: DataStore[] = [];
const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
const GRAPH_ID = `g1:${'7'.repeat(64)}`;
const CONFIG_ID = `sha256:${'8'.repeat(64)}`;

function ledgerId(prefix: 'RUN' | 'STEP', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 26).toUpperCase()}`;
}

const CONTEXT_RUN_ID = ledgerId('RUN', 'private-run-id');
const GRAPH_STEP_ID = ledgerId('STEP', 'private-step-id');
const INVENTORY_STEP_ID = ledgerId('STEP', 'private-inventory-step-id');
const SELECTION_STEP_ID = ledgerId('STEP', 'private-selection-step-id');

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectFixture(): {
  readonly root: string;
  readonly targets: TargetResolver;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'private-context-observability-')));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'private-fixture' }));
  writeFileSync(join(root, 'src', 'private-file.ts'), 'export const privateValue = 1;\n');
  const target: TargetView = {
    config: {
      name: 'source',
      description: 'source',
      include: ['src/**/*.ts'],
      exclude: [],
      languages: ['typescript'],
    },
  };
  return {
    root,
    targets: {
      getByName: () => target,
      getAll: () => [target],
      getByTag: () => [],
      has: () => true,
      resolveTargets: () => [join(root, 'src', 'private-file.ts')],
      applyGlobalExcludes: (files) => files,
      globalExcludes: [],
    },
  };
}

function manifest(runId: string, root: string): TaskContextManifest {
  return {
    schemaVersion: 1,
    suite: 'agent-context',
    runId,
    createdAt: '2026-07-13T00:00:00.000Z',
    projectIdentity: buildTaskContextProjectIdentity(root),
    readiness: 'unavailable',
    sourceStart: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'9'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'9'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    fileScope: buildTaskContextFileScope(['src/private-file.ts']),
    graphIdentity: GRAPH_ID,
    planes: [
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
      },
    ],
    reasonCodes: [],
    nextActions: [],
  };
}

function seedContext(store: DataStore, root: string): void {
  const runId = CONTEXT_RUN_ID;
  const run: StoredRun = {
    id: runId,
    name: 'agent-context',
    source: 'built-in-suite',
    cwd: root,
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
    contextManifest: manifest(runId, root),
  };
  const step: StoredRunStep = {
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
    durationMs: 5,
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
    exitCode: 1,
    outcome: 'faulted',
    durationMs: 3,
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
    durationMs: 3,
  };
  new RunRepo(store).saveRunWithSteps(run, [inventoryStep, step, selectionStep]);
}

describe('task-context lifecycle observability', () => {
  it('logs bounded inventory and replay decisions without paths or opaque identities', async () => {
    const { root, targets } = projectFixture();
    const events: {
      readonly event: string;
      readonly fields: Readonly<Record<string, unknown>>;
    }[] = [];
    const log = (event: string, fields: Readonly<Record<string, unknown>>): void => {
      events.push({ event, fields });
    };
    const codebase = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'private-config',
      targets,
      log,
    });
    const inventoryStatus = await codebase.inventoryStatus();
    expect(inventoryStatus.ok).toBe(true);

    const store = DataStoreFactory.open({ backend: 'memory' });
    stores.push(store);
    seedContext(store, root);
    const graph = {
      contextPointerStatus: (pointer: TaskContextManifest['planes'][number]['pointer']) =>
        Promise.resolve(
          ok({
            pointer: pointer!,
            status: 'stale' as const,
            reasonCodes: ['graph-generation-not-current'],
          }),
        ),
    } as unknown as GraphReadPort;
    const context = new SqliteContextReadPort({
      store,
      projectRoot: root,
      graph,
      codebase,
      log,
    });
    const contextStatus = await context.contextStatus({
      runId: CONTEXT_RUN_ID,
      files: ['src/private-file.ts'],
    });
    expect(contextStatus.ok).toBe(true);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'mcp.codebase.inventory.completed',
          fields: expect.objectContaining({
            status: 'complete',
            packageCount: 1,
            fileCount: 2,
            durationMs: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          event: 'mcp.context.status.resolved',
          fields: {
            readiness: 'unavailable',
            pointerCount: 1,
            unavailableCount: 1,
            scopeStatus: 'matched',
          },
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    for (const secret of [
      root,
      'private-file.ts',
      CONTEXT_RUN_ID,
      GRAPH_STEP_ID,
      'private-snapshot-id',
      'private-config',
      'private-tool-id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps the context path free of a second telemetry authority', () => {
    const files = [
      '../local-codebase-read-port.ts',
      '../sqlite-context-read-port.ts',
      '../../../graph/engine/src/persistence/context-snapshot-repo.ts',
      '../../../cli/src/commands/suite/orchestrator.ts',
    ];
    for (const relative of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/@opentelemetry|createCounter|createHistogram|createGauge/u);
    }
  });
});
