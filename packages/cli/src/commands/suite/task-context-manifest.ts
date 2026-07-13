import {
  TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
  parseTaskContextManifest,
  type TaskContextManifest,
  type TaskContextFileScope,
  type TaskContextPlane,
  type TaskContextReadiness,
  type TaskContextSourceIdentity,
} from '@opensip-cli/contracts';

import { BUILT_IN_AGENT_CONTEXT_PLANES, BUILT_IN_GRAPH_TOOL_ID } from './built-in-suites.js';
import { taskContextSourceIdentityEqual } from './task-context-source-identity.js';

import type { SuiteStepReviewInput } from './review-brief.js';
import type { SuiteLedgerIdentity } from './run-ledger-persist.js';
import type { EvidenceSnapshotContribution } from '@opensip-cli/core';

export const TASK_CONTEXT_PLANE_KINDS = BUILT_IN_AGENT_CONTEXT_PLANES.map((plane) => plane.kind);
type TaskContextPlaneKind = (typeof TASK_CONTEXT_PLANE_KINDS)[number];

function isExpectedKind(value: string): value is TaskContextPlaneKind {
  return (TASK_CONTEXT_PLANE_KINDS as readonly string[]).includes(value);
}

function requiredPlane(kind: TaskContextPlaneKind, fileScope: TaskContextFileScope): boolean {
  return kind !== 'test-selection' || fileScope.mode === 'explicit';
}

function coverageOf(contribution: EvidenceSnapshotContribution): TaskContextPlane['coverage'] {
  return {
    status: contribution.coverage.status,
    reasonCodes: contribution.coverage.reasonCodes ?? [],
    observed: contribution.coverage.items ?? 0,
    ...(contribution.coverage.total === undefined ? {} : { total: contribution.coverage.total }),
  };
}

function statusReadiness(
  contribution: EvidenceSnapshotContribution,
  required: boolean,
): TaskContextReadiness {
  switch (contribution.status) {
    case 'rebuilt':
    case 'reused': {
      return contribution.coverage.status === 'complete' &&
        contribution.freshness.status === 'current'
        ? 'ready'
        : 'degraded';
    }
    case 'partial': {
      return 'degraded';
    }
    case 'unsupported': {
      return required ? 'unavailable' : 'degraded';
    }
    case 'cancelled':
    case 'failed': {
      return 'unavailable';
    }
  }
}

function worstReadiness(
  left: TaskContextReadiness,
  right: TaskContextReadiness,
): TaskContextReadiness {
  const rank: Record<TaskContextReadiness, number> = {
    ready: 0,
    degraded: 1,
    unavailable: 2,
  };
  return rank[right] > rank[left] ? right : left;
}

function reasonCodes(contribution: EvidenceSnapshotContribution): readonly string[] {
  return [
    ...(contribution.reasons?.map((reason) => reason.code) ?? []),
    ...(contribution.coverage.reasonCodes ?? []),
    ...(contribution.freshness.reasonCodes ?? []),
    ...(contribution.freshness.status === 'current'
      ? []
      : [`freshness-${contribution.freshness.status}`]),
  ].filter((code, index, all) => all.indexOf(code) === index);
}

const CAP_REASON = /(?:^|[-_.])(?:cap|limit|truncat(?:ed|ion)?)(?:$|[-_.])/iu;

function capsOf(contribution: EvidenceSnapshotContribution): TaskContextPlane['caps'] {
  const capReasons = reasonCodes(contribution).filter((code) => CAP_REASON.test(code));
  if (capReasons.length > 0) return { status: 'hit', reasonCodes: capReasons };
  if (
    contribution.status === 'unsupported' ||
    contribution.status === 'failed' ||
    contribution.status === 'cancelled' ||
    contribution.coverage.status === 'unavailable'
  ) {
    return { status: 'unknown', reasonCodes: [] };
  }
  return { status: 'not-hit', reasonCodes: [] };
}

function buildPlane(input: {
  readonly contribution: EvidenceSnapshotContribution;
  readonly kind: TaskContextPlaneKind;
  readonly producerVersion: string;
  readonly required: boolean;
  readonly identity: SuiteLedgerIdentity['steps'][number];
  readonly runId: string;
}): TaskContextPlane {
  const contribution = input.contribution;
  const pointer =
    contribution.snapshotId === undefined || contribution.snapshotSchemaVersion === undefined
      ? undefined
      : {
          owner: 'graph' as const,
          kind: input.kind,
          id: contribution.snapshotId,
          schemaVersion: contribution.snapshotSchemaVersion,
        };
  return {
    kind: input.kind,
    required: input.required,
    status: contribution.status,
    producer: {
      toolId: contribution.producer.toolId,
      command: contribution.producer.command,
      version: input.producerVersion,
    },
    ...(pointer === undefined ? {} : { pointer }),
    step: {
      runId: input.runId,
      stepId: input.identity.id,
      logicalStepKey: input.identity.logicalStepKey,
      ordinal: input.identity.ordinal,
      attempt: input.identity.attempt,
    },
    freshness: {
      status: contribution.freshness.status,
      reasonCodes: contribution.freshness.reasonCodes ?? [],
    },
    coverage: coverageOf(contribution),
    caps: capsOf(contribution),
    reasonCodes: reasonCodes(contribution),
    followUpReads: contribution.followUpReads ?? [],
  };
}

export interface BuildTaskContextManifestInput {
  readonly ledger: SuiteLedgerIdentity;
  readonly steps: readonly SuiteStepReviewInput[];
  readonly sourceStart: TaskContextSourceIdentity;
  readonly sourceEnd: TaskContextSourceIdentity;
  readonly expectedProducerVersion: string;
  readonly fileScope: TaskContextFileScope;
  readonly createdAt: string;
  readonly projectIdentity: string;
}

function durablePointerRequired(contribution: EvidenceSnapshotContribution): boolean {
  return (
    contribution.status === 'rebuilt' ||
    contribution.status === 'reused' ||
    contribution.status === 'partial'
  );
}

function contributionMatchesAuthority(input: {
  readonly contribution: EvidenceSnapshotContribution;
  readonly kind: TaskContextPlaneKind;
  readonly command: string;
  readonly producerVersion: string;
}): boolean {
  const contribution = input.contribution;
  return (
    contribution.kind === input.kind &&
    contribution.producer.toolId === BUILT_IN_GRAPH_TOOL_ID &&
    contribution.producer.command === input.command &&
    contribution.producer.version === input.producerVersion &&
    (!durablePointerRequired(contribution) ||
      (contribution.snapshotId !== undefined &&
        contribution.snapshotSchemaVersion !== undefined &&
        contribution.snapshotSchemaVersion > 0))
  );
}

function selectionInputsMatch(
  selection: EvidenceSnapshotContribution,
  inventoryId: string | undefined,
  graphId: string | undefined,
): boolean {
  if (!durablePointerRequired(selection)) return true;
  if (inventoryId === undefined || graphId === undefined || selection.inputs?.length !== 2) {
    return false;
  }
  const inputs = new Map(selection.inputs.map((item) => [item.kind, item.snapshotId]));
  return (
    inputs.size === 2 && inputs.get('inventory') === inventoryId && inputs.get('graph') === graphId
  );
}

/** Pure host aggregation over already validated, metadata-only contributions. */
export function buildTaskContextManifest(
  input: BuildTaskContextManifestInput,
): TaskContextManifest {
  let readiness: TaskContextReadiness = 'ready';
  const manifestReasons: string[] = [];
  const accepted = new Map<TaskContextPlaneKind, EvidenceSnapshotContribution>();
  if (
    input.steps.length !== BUILT_IN_AGENT_CONTEXT_PLANES.length ||
    input.ledger.steps.length !== BUILT_IN_AGENT_CONTEXT_PLANES.length
  ) {
    readiness = 'unavailable';
    manifestReasons.push('step-count-mismatch');
  }

  const planes: TaskContextPlane[] = [];
  BUILT_IN_AGENT_CONTEXT_PLANES.forEach((expected, position) => {
    const kind = expected.kind;
    const required = requiredPlane(kind, input.fileScope);
    const step = input.steps[position];
    if (
      step?.stepIndex !== position ||
      step.summary.stableId !== BUILT_IN_GRAPH_TOOL_ID ||
      step.summary.command !== expected.command ||
      step.summary.kind !== 'evidence'
    ) {
      readiness = 'unavailable';
      manifestReasons.push('step-authority-mismatch');
      return;
    }
    const contributions = step.evidenceSnapshots ?? [];
    if (contributions.length !== 1) {
      // Optional means an explicit negative contribution may degrade the
      // manifest. Missing or ambiguous producer output is an integrity fault:
      // there is no plane to authenticate or persist, so fail closed.
      readiness = 'unavailable';
      manifestReasons.push(`missing-${kind}`, 'contribution-count-mismatch');
      return;
    }
    const contribution = contributions[0];
    if (
      contribution === undefined ||
      !isExpectedKind(contribution.kind) ||
      !contributionMatchesAuthority({
        contribution,
        kind,
        command: expected.command,
        producerVersion: input.expectedProducerVersion,
      })
    ) {
      readiness = 'unavailable';
      manifestReasons.push('contribution-authority-mismatch');
      return;
    }
    const identity = input.ledger.steps[position];
    if (
      identity?.ordinal !== step.stepIndex ||
      identity.logicalStepKey !==
        `${String(position)}:${BUILT_IN_GRAPH_TOOL_ID}:${expected.command}`
    ) {
      readiness = 'unavailable';
      manifestReasons.push('ledger-identity-mismatch');
      return;
    }
    accepted.set(kind, contribution);
    readiness = worstReadiness(readiness, statusReadiness(contribution, required));
    if (contribution.freshness.status !== 'current') {
      manifestReasons.push(`${kind}-freshness-${contribution.freshness.status}`);
    }
    planes.push(
      buildPlane({
        contribution,
        kind,
        producerVersion: input.expectedProducerVersion,
        required,
        identity,
        runId: input.ledger.runId,
      }),
    );
  });

  const inventoryIdentity = accepted.get('inventory')?.snapshotId;
  const graphIdentity = accepted.get('graph')?.snapshotId;
  const selection = accepted.get('test-selection');
  if (
    selection !== undefined &&
    !selectionInputsMatch(selection, inventoryIdentity, graphIdentity)
  ) {
    readiness = 'unavailable';
    manifestReasons.push('test-selection-input-mismatch');
  }

  const sourceDrift = !taskContextSourceIdentityEqual(input.sourceStart, input.sourceEnd);
  if (sourceDrift) {
    readiness = worstReadiness(readiness, 'degraded');
    manifestReasons.push('source-drift');
  }
  if (input.sourceStart.status !== 'captured' || input.sourceEnd.status !== 'captured') {
    readiness = worstReadiness(readiness, 'degraded');
    manifestReasons.push('source-identity-unavailable');
  }

  const rerunAction =
    input.fileScope.mode === 'explicit'
      ? 'opensip suite run agent-context --files <same-explicit-files> --json'
      : 'opensip suite run agent-context --json';
  const nextActions =
    readiness === 'unavailable' || sourceDrift
      ? [rerunAction]
      : ['get_context_status', 'get_file_context', 'impact_files', 'select_tests'];
  const manifestPlanes = sourceDrift
    ? planes.map((plane) => ({
        ...plane,
        reasonCodes: [...new Set([...plane.reasonCodes, 'source-drift'])],
      }))
    : planes;
  const manifest: TaskContextManifest = {
    schemaVersion: TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
    suite: 'agent-context',
    runId: input.ledger.runId,
    createdAt: input.createdAt,
    projectIdentity: input.projectIdentity,
    readiness,
    sourceStart: input.sourceStart,
    sourceEnd: input.sourceEnd,
    fileScope: input.fileScope,
    ...(graphIdentity === undefined ? {} : { graphIdentity }),
    ...(inventoryIdentity === undefined ? {} : { inventoryIdentity }),
    planes: manifestPlanes,
    reasonCodes: manifestReasons.filter((code, index, all) => all.indexOf(code) === index),
    nextActions,
  };
  return parseTaskContextManifest(manifest);
}
