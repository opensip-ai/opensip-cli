import { describe, expect, it } from 'vitest';

import {
  TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
  buildProjectInventorySnapshotIdentities,
  buildTaskContextFileScope,
  buildTaskContextProjectIdentity,
  buildTestSelectionSnapshotIdentity,
  parseTaskContextManifest,
  projectInventorySnapshotIdentityMatches,
  projectInventorySnapshotSchema,
  taskContextManifestSchema,
  testSelectionSnapshotIdentityMatches,
  testSelectionSnapshotSchema,
  type ProjectInventorySnapshot,
  type TaskContextManifest,
  type TestSelectionSnapshot,
} from '../index.js';

const INVENTORY_ID = `i1:${'1'.repeat(64)}`;
const OTHER_INVENTORY_ID = `i1:${'2'.repeat(64)}`;
const INVENTORY_METADATA_ID = `m1:${'3'.repeat(64)}`;
const GRAPH_ID = `g1:${'4'.repeat(64)}`;
const OTHER_GRAPH_ID = `g1:${'5'.repeat(64)}`;
const TEST_SELECTION_ID = `ts1:${'6'.repeat(64)}`;
const RUN_ID = `RUN_${'0'.repeat(26)}`;
const CONFIG_ID = `sha256:${'7'.repeat(64)}`;

function pointerId(kind: TaskContextManifest['planes'][number]['kind']): string {
  if (kind === 'inventory') return INVENTORY_ID;
  if (kind === 'graph') return GRAPH_ID;
  return TEST_SELECTION_ID;
}

function manifest(): TaskContextManifest {
  const plane = (
    kind: TaskContextManifest['planes'][number]['kind'],
    ordinal: number,
  ): TaskContextManifest['planes'][number] => ({
    kind,
    required: true,
    status: 'rebuilt',
    producer: {
      toolId: 'graph-tool',
      command: `graph-context-${kind}`,
      version: '1.0.0',
    },
    pointer: {
      owner: 'graph',
      kind,
      id: pointerId(kind),
      schemaVersion: 1,
    },
    step: {
      runId: RUN_ID,
      stepId: `STEP_${'0'.repeat(25)}${String(ordinal)}`,
      logicalStepKey: `${String(ordinal)}:graph:graph-context-${kind}`,
      ordinal,
      attempt: 1,
    },
    freshness: { status: 'current', reasonCodes: [] },
    coverage: {
      status: 'complete',
      reasonCodes: [],
      observed: 3,
      total: 3,
    },
    caps: { status: 'not-hit', reasonCodes: [] },
    reasonCodes: [],
    followUpReads: ['get_context_status'],
  });
  return {
    schemaVersion: TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
    suite: 'agent-context',
    runId: RUN_ID,
    createdAt: '2026-07-13T00:00:00.000Z',
    projectIdentity: buildTaskContextProjectIdentity('/canonical/project'),
    readiness: 'ready',
    sourceStart: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'8'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    sourceEnd: {
      configIdentity: CONFIG_ID,
      gitHead: 'a'.repeat(40),
      worktreeIdentity: `sha256:${'8'.repeat(64)}`,
      dirty: false,
      status: 'captured',
      reasonCodes: [],
    },
    fileScope: buildTaskContextFileScope(['src/task.ts']),
    graphIdentity: GRAPH_ID,
    inventoryIdentity: INVENTORY_ID,
    planes: [plane('inventory', 0), plane('graph', 1), plane('test-selection', 2)],
    reasonCodes: [],
    nextActions: [],
  };
}

describe('task-context contracts', () => {
  it('requires exact bounded inventory language/count and evidence-support facts', () => {
    const snapshot = {
      schemaVersion: 1,
      snapshotId: INVENTORY_ID,
      metadataIdentity: INVENTORY_METADATA_ID,
      project: {
        workspacePatterns: [],
        languages: ['klingon'],
        fileCount: 1,
        packageCount: 0,
        configIdentity: 'sha256:config',
      },
      packages: [],
      files: [
        {
          path: 'src/example.kl',
          size: 1,
          modifiedMs: 1,
          roles: ['unknown'],
          targets: ['source'],
          languages: ['klingon'],
          evidenceSupport: {
            callable: 'unknown',
            declaration: 'unsupported',
            reference: 'unsupported',
          },
          provenance: [{ source: 'target', detail: 'target:source' }],
        },
      ],
      coverage: { status: 'complete', reasonCodes: [], observed: 1, total: 1 },
    };
    expect(projectInventorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...snapshot,
        project: { ...snapshot.project, fileCount: 0 },
      }).success,
    ).toBe(false);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...snapshot,
        project: { ...snapshot.project, languages: [] },
      }).success,
    ).toBe(false);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...snapshot,
        snapshotId: 'inventory',
      }).success,
    ).toBe(false);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...snapshot,
        metadataIdentity: 'metadata',
      }).success,
    ).toBe(false);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...snapshot,
        coverage: {
          status: 'partial',
          reasonCodes: ['cap'],
          observed: 2,
          total: 1,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate package identities and unsafe verification argv at the DTO boundary', () => {
    const command = {
      tier: 'full' as const,
      cwd: '.',
      argv: ['vitest', 'run'],
      basis: 'manifest-script:test',
    };
    const pkg = {
      name: 'root',
      root: '.',
      private: true,
      exports: [],
      bins: [],
      verificationCommands: [command],
      provenance: [{ source: 'manifest' as const, detail: 'package.json' }],
    };
    const base = {
      schemaVersion: 1,
      snapshotId: INVENTORY_ID,
      metadataIdentity: INVENTORY_METADATA_ID,
      project: {
        workspacePatterns: [],
        languages: [],
        fileCount: 0,
        packageCount: 1,
        configIdentity: 'sha256:config',
      },
      packages: [pkg],
      files: [],
      coverage: { status: 'complete', reasonCodes: [], observed: 0, total: 0 },
    };
    expect(projectInventorySnapshotSchema.safeParse(base).success).toBe(true);
    for (const argv of [
      ['rm', '-rf', '.'],
      ['vitest', '--watch'],
      ['eslint', '--fix', '.'],
      ['vitest', 'run', '../outside.test.ts'],
      ['vitest', 'run', '--token=secret'],
    ]) {
      expect(
        projectInventorySnapshotSchema.safeParse({
          ...base,
          packages: [{ ...pkg, verificationCommands: [{ ...command, argv }] }],
        }).success,
      ).toBe(false);
    }
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...base,
        project: { ...base.project, packageCount: 2 },
        packages: [pkg, { ...pkg, root: 'packages/other' }],
      }).success,
    ).toBe(false);
    expect(
      projectInventorySnapshotSchema.safeParse({
        ...base,
        project: { ...base.project, packageCount: 2 },
        packages: [pkg, { ...pkg, name: 'other' }],
      }).success,
    ).toBe(false);
  });

  it('requires the test-selection identity namespace', () => {
    const selection = {
      schemaVersion: 1,
      snapshotId: TEST_SELECTION_ID,
      files: ['src/example.ts'],
      tests: [],
      commands: [],
      uncoveredFiles: ['src/example.ts'],
      trust: { status: 'fallback', reasonCodes: [], fallbackTier: 'full' },
      graphIdentity: GRAPH_ID,
      inventoryIdentity: INVENTORY_ID,
    };
    expect(testSelectionSnapshotSchema.safeParse(selection).success).toBe(true);
    expect(
      testSelectionSnapshotSchema.safeParse({
        ...selection,
        snapshotId: 'selection',
      }).success,
    ).toBe(false);
  });

  it('derives immutable inventory and selection IDs from canonical complete content', () => {
    const inventoryInput: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'> = {
      schemaVersion: 1,
      project: {
        workspacePatterns: [],
        languages: [],
        fileCount: 0,
        packageCount: 0,
        configIdentity: CONFIG_ID,
      },
      packages: [],
      files: [],
      coverage: { status: 'complete', reasonCodes: [], observed: 0, total: 0 },
    };
    const inventoryIdentities = buildProjectInventorySnapshotIdentities(inventoryInput);
    const inventorySnapshot = { ...inventoryInput, ...inventoryIdentities };
    expect(inventoryIdentities).toMatchObject({
      snapshotId: expect.stringMatching(/^i1:[a-f0-9]{64}$/u),
      metadataIdentity: expect.stringMatching(/^m1:[a-f0-9]{64}$/u),
    });
    expect(projectInventorySnapshotIdentityMatches(inventorySnapshot)).toBe(true);
    expect(
      projectInventorySnapshotIdentityMatches({
        ...inventorySnapshot,
        project: {
          ...inventorySnapshot.project,
          configIdentity: `sha256:${'9'.repeat(64)}`,
        },
      }),
    ).toBe(false);

    const selectionInput: Omit<TestSelectionSnapshot, 'snapshotId'> = {
      schemaVersion: 1,
      files: ['src/example.ts'],
      tests: [],
      commands: [],
      uncoveredFiles: ['src/example.ts'],
      trust: { status: 'fallback', reasonCodes: [], fallbackTier: 'full' },
      graphIdentity: GRAPH_ID,
      inventoryIdentity: inventorySnapshot.snapshotId,
    };
    const selectionSnapshot = {
      ...selectionInput,
      snapshotId: buildTestSelectionSnapshotIdentity(selectionInput),
    };
    expect(selectionSnapshot.snapshotId).toMatch(/^ts1:[a-f0-9]{64}$/u);
    expect(testSelectionSnapshotIdentityMatches(selectionSnapshot)).toBe(true);
    expect(
      testSelectionSnapshotIdentityMatches({
        ...selectionSnapshot,
        graphIdentity: OTHER_GRAPH_ID,
      }),
    ).toBe(false);
  });

  it('round-trips the versioned bounded manifest', () => {
    const value = manifest();
    expect(parseTaskContextManifest(structuredClone(value))).toEqual(value);
  });

  it('requires complete captured source identity and reasoned field-minimal failures', () => {
    const value = manifest();
    for (const sourceStart of [
      { ...value.sourceStart, gitHead: undefined },
      { ...value.sourceStart, worktreeIdentity: undefined },
      { ...value.sourceStart, dirty: undefined },
      { ...value.sourceStart, reasonCodes: ['unexpected'] },
    ]) {
      expect(taskContextManifestSchema.safeParse({ ...value, sourceStart }).success).toBe(false);
    }
    expect(
      taskContextManifestSchema.safeParse({
        ...value,
        readiness: 'degraded',
        sourceStart: {
          configIdentity: CONFIG_ID,
          status: 'unsupported',
          reasonCodes: [],
        },
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...value,
        readiness: 'degraded',
        sourceStart: {
          ...value.sourceStart,
          status: 'failed',
          reasonCodes: ['git-status-failed'],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported versions and duplicate planes', () => {
    expect(taskContextManifestSchema.safeParse({ ...manifest(), schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: [...manifest().planes, ...manifest().planes],
      }).success,
    ).toBe(false);
  });

  it('rejects top-level identities that do not bind the exact plane pointer', () => {
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        inventoryIdentity: OTHER_INVENTORY_ID,
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        graphIdentity: OTHER_GRAPH_ID,
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        inventoryIdentity: INVENTORY_ID,
      }).success,
    ).toBe(true);
  });

  it('requires canonical time, project identity, and exact durable plane pointers', () => {
    expect(buildTaskContextProjectIdentity('/canonical/project')).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => buildTaskContextProjectIdentity('bad\nroot')).toThrow('bounded canonical path');
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        createdAt: '2026-07-13T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        projectIdentity: '/canonical/project',
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        readiness: 'degraded',
        planes: manifest().planes.map((plane, index) =>
          index === 0 ? { ...plane, status: 'partial', pointer: undefined } : plane,
        ),
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: manifest().planes.map((plane, index) =>
          index === 0
            ? {
                ...plane,
                pointer: { ...plane.pointer!, kind: 'test-selection' },
              }
            : plane,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown, missing, false-ready, and invalid required-plane policy', () => {
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: [{ ...manifest().planes[0], kind: 'hostile-plane' }],
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: manifest().planes.filter((plane) => plane.kind !== 'graph'),
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: manifest().planes.map((plane) =>
          plane.kind === 'graph' ? { ...plane, status: 'failed', pointer: undefined } : plane,
        ),
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: manifest().planes.map((plane) =>
          plane.kind === 'graph' ? { ...plane, required: false } : plane,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects invalid readiness and overlong actions', () => {
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        readiness: 'complete',
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        nextActions: ['x'.repeat(513)],
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        planes: manifest().planes.map((plane, index) =>
          index === 0
            ? {
                ...plane,
                caps: { status: 'hit', reasonCodes: ['file-cap-reached'] },
              }
            : plane,
        ),
      }).success,
    ).toBe(false);
  });

  it('builds an order-independent, normalized, deduplicated file-scope identity', () => {
    const scope = buildTaskContextFileScope(['src\\task.ts', 'src/other.ts', 'src/task.ts']);
    expect(scope).toEqual(buildTaskContextFileScope(['src/task.ts', 'src/other.ts']));
    expect(scope).toMatchObject({ mode: 'explicit', fileCount: 2 });
    expect(scope.filesIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(scope)).not.toContain('src/');
  });

  it('distinguishes project scope and rejects path-bearing or contradictory manifest scope', () => {
    expect(buildTaskContextFileScope()).toMatchObject({
      mode: 'project',
      fileCount: 0,
    });
    expect(() => buildTaskContextFileScope(['/private/task.ts'])).toThrow(
      'normalized project-relative paths',
    );
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        fileScope: { ...manifest().fileScope, mode: 'project', fileCount: 1 },
      }).success,
    ).toBe(false);
    expect(
      taskContextManifestSchema.safeParse({
        ...manifest(),
        fileScope: { ...manifest().fileScope, files: ['src/task.ts'] },
      }).success,
    ).toBe(false);
  });
});
