import { buildTaskContextFileScope } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_AGENT_CONTEXT_PLANES, BUILT_IN_GRAPH_TOOL_ID } from '../built-in-suites.js';
import { buildTaskContextManifest } from '../task-context-manifest.js';

import type { SuiteStepReviewInput } from '../review-brief.js';
import type { SuiteLedgerIdentity } from '../run-ledger-persist.js';
import type { EvidenceSnapshotContribution } from '@opensip-cli/core';

const ledger: SuiteLedgerIdentity = {
  runId: `RUN_${'0'.repeat(26)}`,
  steps: BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, ordinal) => ({
    id: `STEP_${'0'.repeat(25)}${String(ordinal)}`,
    logicalStepKey: `${String(ordinal)}:${BUILT_IN_GRAPH_TOOL_ID}:${plane.command}`,
    ordinal,
    attempt: 1,
  })),
};

const PRODUCER_VERSION = '0.6.0';
const INVENTORY_ID = `i1:${'1'.repeat(64)}`;
const GRAPH_ID = `g1:${'2'.repeat(64)}`;
const TEST_SELECTION_ID = `ts1:${'3'.repeat(64)}`;
const DIFFERENT_GRAPH_ID = `g1:${'4'.repeat(64)}`;
const CONFIG_ID = `sha256:${'5'.repeat(64)}`;
const CLEAN_WORKTREE_ID = `sha256:${'6'.repeat(64)}`;
const DIRTY_WORKTREE_ID = `sha256:${'7'.repeat(64)}`;
const EXPLICIT_FILE_SCOPE = buildTaskContextFileScope(['src/task.ts']);
const PROJECT_FILE_SCOPE = buildTaskContextFileScope();

function commandFor(kind: string): string {
  return (
    BUILT_IN_AGENT_CONTEXT_PLANES.find((plane) => plane.kind === kind)?.command ??
    `unexpected-${kind}`
  );
}

function snapshotIdFor(kind: string): string {
  if (kind === 'inventory') return INVENTORY_ID;
  if (kind === 'graph') return GRAPH_ID;
  return TEST_SELECTION_ID;
}

function evidence(
  kind: string,
  status: EvidenceSnapshotContribution['status'] = 'rebuilt',
  includeSelectionInputs = true,
): EvidenceSnapshotContribution {
  return {
    schemaVersion: 1,
    kind,
    ...(['rebuilt', 'reused', 'partial'].includes(status)
      ? { snapshotId: snapshotIdFor(kind), snapshotSchemaVersion: kind === 'graph' ? 3 : 1 }
      : {}),
    producer: {
      toolId: BUILT_IN_GRAPH_TOOL_ID,
      command: commandFor(kind),
      version: PRODUCER_VERSION,
    },
    status,
    freshness: { status: 'current' },
    coverage: {
      status: status === 'partial' ? 'partial' : 'complete',
      items: 1,
      total: 1,
    },
    ...(includeSelectionInputs &&
    kind === 'test-selection' &&
    ['rebuilt', 'reused', 'partial'].includes(status)
      ? {
          inputs: [
            { kind: 'graph', snapshotId: GRAPH_ID },
            { kind: 'inventory', snapshotId: INVENTORY_ID },
          ],
        }
      : {}),
  };
}

function steps(status: EvidenceSnapshotContribution['status'] = 'rebuilt'): SuiteStepReviewInput[] {
  return BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, stepIndex) => ({
    stepIndex,
    summary: {
      tool: 'graph',
      stableId: BUILT_IN_GRAPH_TOOL_ID,
      command: plane.command,
      exitCode: 0,
      durationMs: 1,
      outcome: 'passed',
      kind: 'evidence',
      readiness: status === 'rebuilt' ? 'ready' : 'degraded',
    },
    evidenceSnapshots: [evidence(plane.kind, plane.kind === 'test-selection' ? status : 'rebuilt')],
  }));
}

const source = {
  configIdentity: CONFIG_ID,
  gitHead: 'a'.repeat(40),
  worktreeIdentity: CLEAN_WORKTREE_ID,
  dirty: false,
  status: 'captured' as const,
  reasonCodes: [],
};

type ManifestInput = Parameters<typeof buildTaskContextManifest>[0];

function buildManifest(input: Omit<ManifestInput, 'createdAt' | 'projectIdentity'>) {
  return buildTaskContextManifest({
    ...input,
    createdAt: '2026-07-13T00:00:00.000Z',
    projectIdentity: `sha256:${'a'.repeat(64)}`,
  });
}

describe('buildTaskContextManifest', () => {
  it('builds exact parent and step references for ready evidence', () => {
    const manifest = buildManifest({
      ledger,
      steps: steps(),
      sourceStart: source,
      sourceEnd: source,
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: EXPLICIT_FILE_SCOPE,
    });
    expect(manifest.readiness).toBe('ready');
    expect(manifest.runId).toBe(ledger.runId);
    expect(manifest.planes.map((plane) => plane.step.stepId)).toEqual(
      ledger.steps.map((step) => step.id),
    );
    expect(manifest.planes.every((plane) => plane.producer.version === PRODUCER_VERSION)).toBe(
      true,
    );
    expect(manifest.planes.every((plane) => plane.caps.status === 'not-hit')).toBe(true);
  });

  it('degrades optional no-files selection but fails required unsupported selection', () => {
    expect(
      buildManifest({
        ledger,
        steps: steps('unsupported'),
        sourceStart: source,
        sourceEnd: source,
        expectedProducerVersion: PRODUCER_VERSION,
        fileScope: PROJECT_FILE_SCOPE,
      }).readiness,
    ).toBe('degraded');
    expect(
      buildManifest({
        ledger,
        steps: steps('unsupported'),
        sourceStart: source,
        sourceEnd: source,
        expectedProducerVersion: PRODUCER_VERSION,
        fileScope: EXPLICIT_FILE_SCOPE,
      }).readiness,
    ).toBe('unavailable');
  });

  it('fails closed when an optional no-files selection contribution is absent', () => {
    const missingSelection = steps();
    missingSelection[2] = {
      ...missingSelection[2],
      evidenceSnapshots: [],
    };

    const manifest = buildManifest({
      ledger,
      steps: missingSelection,
      sourceStart: source,
      sourceEnd: source,
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: PROJECT_FILE_SCOPE,
    });

    expect(manifest.readiness).toBe('unavailable');
    expect(manifest.reasonCodes).toEqual(
      expect.arrayContaining(['missing-test-selection', 'contribution-count-mismatch']),
    );
    expect(manifest.planes.map((plane) => plane.kind)).toEqual(['inventory', 'graph']);
  });

  it('marks duplicate, missing, and source-drift evidence unavailable or degraded', () => {
    const duplicate = steps();
    duplicate[1] = {
      ...duplicate[1],
      evidenceSnapshots: [evidence('inventory')],
    };
    expect(
      buildManifest({
        ledger,
        steps: duplicate,
        sourceStart: source,
        sourceEnd: source,
        expectedProducerVersion: PRODUCER_VERSION,
        fileScope: EXPLICIT_FILE_SCOPE,
      }).readiness,
    ).toBe('unavailable');

    const drifted = buildManifest({
      ledger,
      steps: steps(),
      sourceStart: source,
      sourceEnd: { ...source, worktreeIdentity: DIRTY_WORKTREE_ID, dirty: true },
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: EXPLICIT_FILE_SCOPE,
    });
    expect(drifted.readiness).toBe('degraded');
    expect(drifted.reasonCodes).toContain('source-drift');
    expect(drifted.planes.every((plane) => plane.reasonCodes.includes('source-drift'))).toBe(true);
    expect(drifted.nextActions).toEqual([
      'opensip suite run agent-context --files <same-explicit-files> --json',
    ]);
  });

  it('fails closed when step or contribution authority does not match the bundled graph chain', () => {
    const wrongStep = steps();
    wrongStep[0] = {
      ...wrongStep[0],
      summary: { ...wrongStep[0].summary, stableId: 'spoofed-graph' },
    };
    const stepManifest = buildManifest({
      ledger,
      steps: wrongStep,
      sourceStart: source,
      sourceEnd: source,
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: EXPLICIT_FILE_SCOPE,
    });
    expect(stepManifest.readiness).toBe('unavailable');
    expect(stepManifest.reasonCodes).toContain('step-authority-mismatch');

    const wrongProducer = steps();
    wrongProducer[1] = {
      ...wrongProducer[1],
      evidenceSnapshots: [
        {
          ...evidence('graph'),
          producer: {
            toolId: BUILT_IN_GRAPH_TOOL_ID,
            command: commandFor('graph'),
            version: 'spoofed-version',
          },
        },
      ],
    };
    const producerManifest = buildManifest({
      ledger,
      steps: wrongProducer,
      sourceStart: source,
      sourceEnd: source,
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: EXPLICIT_FILE_SCOPE,
    });
    expect(producerManifest.readiness).toBe('unavailable');
    expect(producerManifest.reasonCodes).toContain('contribution-authority-mismatch');
  });

  it('requires test-selection to bind the exact inventory and graph snapshots', () => {
    for (const inputs of [
      undefined,
      [
        { kind: 'graph', snapshotId: DIFFERENT_GRAPH_ID },
        { kind: 'inventory', snapshotId: INVENTORY_ID },
      ],
    ] as const) {
      const mismatched = steps();
      const selectionWithoutInputs = evidence('test-selection', 'rebuilt', false);
      mismatched[2] = {
        ...mismatched[2],
        evidenceSnapshots: [
          inputs === undefined ? selectionWithoutInputs : { ...selectionWithoutInputs, inputs },
        ],
      };
      const manifest = buildManifest({
        ledger,
        steps: mismatched,
        sourceStart: source,
        sourceEnd: source,
        expectedProducerVersion: PRODUCER_VERSION,
        fileScope: EXPLICIT_FILE_SCOPE,
      });
      expect(manifest.readiness).toBe('unavailable');
      expect(manifest.reasonCodes).toContain('test-selection-input-mismatch');
    }
  });

  it.each(['stale', 'unknown'] as const)(
    'degrades rebuilt evidence whose freshness is %s and records the reason',
    (freshness) => {
      const notCurrent = steps();
      notCurrent[0] = {
        ...notCurrent[0],
        evidenceSnapshots: [{ ...evidence('inventory'), freshness: { status: freshness } }],
      };
      const manifest = buildManifest({
        ledger,
        steps: notCurrent,
        sourceStart: source,
        sourceEnd: source,
        expectedProducerVersion: PRODUCER_VERSION,
        fileScope: EXPLICIT_FILE_SCOPE,
      });
      expect(manifest.readiness).toBe('degraded');
      expect(manifest.reasonCodes).toContain(`inventory-freshness-${freshness}`);
      expect(manifest.planes[0]?.reasonCodes).toContain(`freshness-${freshness}`);
    },
  );

  it('projects producer cap reasons explicitly and prevents a ready claim', () => {
    const capped = steps();
    capped[0] = {
      ...capped[0],
      evidenceSnapshots: [
        {
          ...evidence('inventory', 'partial'),
          coverage: {
            status: 'partial',
            items: 20_000,
            reasonCodes: ['file-cap-reached'],
          },
        },
      ],
    };
    const manifest = buildManifest({
      ledger,
      steps: capped,
      sourceStart: source,
      sourceEnd: source,
      expectedProducerVersion: PRODUCER_VERSION,
      fileScope: EXPLICIT_FILE_SCOPE,
    });
    expect(manifest.readiness).toBe('degraded');
    expect(manifest.planes[0]?.caps).toEqual({
      status: 'hit',
      reasonCodes: ['file-cap-reached'],
    });
  });
});
