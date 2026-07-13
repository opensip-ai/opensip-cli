import { isRecord } from '@opensip-cli/core';

import {
  CAP_REASON,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  GRAPH_TOOL_ID,
  GRAPH_TOOL_NAME,
  PLANE_AUTHORITY,
  SAFE_VERSION,
  boundedControlFreeText,
  exactKeys,
  exactOptionalKeys,
} from './context-authority-shared.js';

import type { EvidenceStatus } from './context-authority-shared.js';
import type { StoredRunStep, TaskContextManifest, TaskContextPlane } from '@opensip-cli/contracts';

function optionalStringArray(value: unknown): readonly string[] | undefined | false {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : false;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function manifestSourceDrifted(manifest: TaskContextManifest): boolean {
  const left = manifest.sourceStart;
  const right = manifest.sourceEnd;
  return (
    left.status !== right.status ||
    left.configIdentity !== right.configIdentity ||
    left.gitHead !== right.gitHead ||
    left.worktreeIdentity !== right.worktreeIdentity ||
    left.dirty !== right.dirty
  );
}

function optionalCount(value: unknown): number | undefined | false {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : false;
}

function normalizedReasonCodes(input: {
  readonly status: string;
  readonly reasons: readonly string[];
  readonly coverageReasons: readonly string[];
  readonly freshnessReasons: readonly string[];
}): readonly string[] {
  return [
    ...input.reasons,
    ...input.coverageReasons,
    ...input.freshnessReasons,
    ...(input.status === 'current' ? [] : [`freshness-${input.status}`]),
  ].filter((code, index, all) => all.indexOf(code) === index);
}

function evidenceCaps(input: {
  readonly status: string;
  readonly coverageStatus: string;
  readonly reasonCodes: readonly string[];
}): TaskContextPlane['caps'] {
  const reasons = input.reasonCodes.filter((code) => CAP_REASON.test(code));
  if (reasons.length > 0) return { status: 'hit', reasonCodes: reasons };
  if (
    input.status === 'unsupported' ||
    input.status === 'failed' ||
    input.status === 'cancelled' ||
    input.coverageStatus === 'unavailable'
  ) {
    return { status: 'unknown', reasonCodes: [] };
  }
  return { status: 'not-hit', reasonCodes: [] };
}

function evidenceInputsMatch(
  value: unknown,
  plane: TaskContextPlane,
  manifest: TaskContextManifest,
): boolean {
  if (value === undefined) {
    return (
      plane.kind !== 'test-selection' ||
      (plane.status !== 'rebuilt' && plane.status !== 'reused' && plane.status !== 'partial')
    );
  }
  if (!Array.isArray(value) || value.length > 16) return false;
  const inputs = new Map<string, string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ['kind', 'snapshotId']) ||
      typeof item.kind !== 'string' ||
      typeof item.snapshotId !== 'string' ||
      inputs.has(item.kind)
    ) {
      return false;
    }
    inputs.set(item.kind, item.snapshotId);
  }
  if (
    plane.kind !== 'test-selection' ||
    (plane.status !== 'rebuilt' && plane.status !== 'reused' && plane.status !== 'partial')
  ) {
    return true;
  }
  return (
    inputs.size === 2 &&
    manifest.inventoryIdentity !== undefined &&
    manifest.graphIdentity !== undefined &&
    inputs.get('inventory') === manifest.inventoryIdentity &&
    inputs.get('graph') === manifest.graphIdentity
  );
}

function evidenceMatchesPlane(
  value: unknown,
  plane: TaskContextPlane,
  manifest: TaskContextManifest,
): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['kind', 'schemaVersion', 'snapshots']) ||
    value.kind !== 'evidence-snapshots' ||
    value.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length !== 1
  ) {
    return false;
  }
  const snapshot: unknown = value.snapshots[0];
  if (!isRecord(snapshot)) return false;
  if (
    !exactOptionalKeys(
      snapshot,
      ['kind', 'status', 'producer', 'freshness', 'coverage'],
      ['snapshotId', 'snapshotSchemaVersion', 'inputs', 'reasonCodes', 'followUpReads'],
    ) ||
    snapshot.kind !== plane.kind ||
    snapshot.status !== plane.status ||
    !isRecord(snapshot.producer) ||
    !exactKeys(snapshot.producer, ['toolId', 'command', 'version']) ||
    snapshot.producer.toolId !== plane.producer.toolId ||
    snapshot.producer.command !== plane.producer.command ||
    snapshot.producer.version !== plane.producer.version ||
    !isRecord(snapshot.freshness) ||
    !exactOptionalKeys(snapshot.freshness, ['status'], ['reasonCodes']) ||
    snapshot.freshness.status !== plane.freshness.status ||
    !isRecord(snapshot.coverage) ||
    !exactOptionalKeys(snapshot.coverage, ['status'], ['items', 'total', 'reasonCodes']) ||
    snapshot.coverage.status !== plane.coverage.status
  ) {
    return false;
  }
  const freshnessReasons = optionalStringArray(snapshot.freshness.reasonCodes);
  const coverageReasons = optionalStringArray(snapshot.coverage.reasonCodes);
  const reasons = optionalStringArray(snapshot.reasonCodes);
  const followUpReads = optionalStringArray(snapshot.followUpReads);
  const items = optionalCount(snapshot.coverage.items);
  const total = optionalCount(snapshot.coverage.total);
  if (
    freshnessReasons === false ||
    coverageReasons === false ||
    reasons === false ||
    followUpReads === false ||
    items === false ||
    total === false
  ) {
    return false;
  }
  const normalizedFreshnessReasons = freshnessReasons ?? [];
  const normalizedCoverageReasons = coverageReasons ?? [];
  const normalizedReasons = normalizedReasonCodes({
    status: String(snapshot.freshness.status),
    reasons: reasons ?? [],
    coverageReasons: normalizedCoverageReasons,
    freshnessReasons: normalizedFreshnessReasons,
  });
  const expectedPlaneReasons =
    manifestSourceDrifted(manifest) && !normalizedReasons.includes('source-drift')
      ? [...normalizedReasons, 'source-drift']
      : normalizedReasons;
  const pointerPresent =
    snapshot.snapshotId !== undefined || snapshot.snapshotSchemaVersion !== undefined;
  if (
    (pointerPresent &&
      (typeof snapshot.snapshotId !== 'string' ||
        !Number.isSafeInteger(snapshot.snapshotSchemaVersion) ||
        (snapshot.snapshotSchemaVersion as number) < 1 ||
        plane.pointer?.owner !== 'graph' ||
        plane.pointer.kind !== plane.kind ||
        plane.pointer.id !== snapshot.snapshotId ||
        plane.pointer.schemaVersion !== snapshot.snapshotSchemaVersion)) ||
    (!pointerPresent && plane.pointer !== undefined) ||
    !sameStrings(normalizedFreshnessReasons, plane.freshness.reasonCodes) ||
    !sameStrings(normalizedCoverageReasons, plane.coverage.reasonCodes) ||
    plane.coverage.observed !== (items ?? 0) ||
    plane.coverage.total !== total ||
    !sameStrings(expectedPlaneReasons, plane.reasonCodes) ||
    !sameStrings(followUpReads ?? [], plane.followUpReads) ||
    !evidenceInputsMatch(snapshot.inputs, plane, manifest)
  ) {
    return false;
  }
  const caps = evidenceCaps({
    status: String(snapshot.status),
    coverageStatus: String(snapshot.coverage.status),
    reasonCodes: expectedPlaneReasons,
  });
  return caps.status === plane.caps.status && sameStrings(caps.reasonCodes, plane.caps.reasonCodes);
}

export function planeMatchesStoredStep(
  plane: TaskContextPlane,
  step: StoredRunStep,
  manifest: TaskContextManifest,
): boolean {
  const authority = PLANE_AUTHORITY[plane.kind];
  const logicalStepKey = `${String(authority.ordinal)}:${GRAPH_TOOL_ID}:${authority.command}`;
  return (
    plane.required ===
      (plane.kind !== 'test-selection' || manifest.fileScope.mode === 'explicit') &&
    plane.producer.toolId === GRAPH_TOOL_ID &&
    plane.producer.command === authority.command &&
    plane.step.ordinal === authority.ordinal &&
    plane.step.attempt === 1 &&
    plane.step.logicalStepKey === logicalStepKey &&
    step.tool === GRAPH_TOOL_NAME &&
    step.stableId === GRAPH_TOOL_ID &&
    step.command === authority.command &&
    step.ordinal === authority.ordinal &&
    step.attempt === 1 &&
    step.logicalStepKey === logicalStepKey &&
    evidenceMatchesPlane(step.evidence, plane, manifest)
  );
}

export function projectedEvidenceStatus(
  step: StoredRunStep,
  kind: TaskContextPlane['kind'],
  command: string,
): EvidenceStatus | 'missing' | undefined {
  if (step.evidence === undefined) return 'missing';
  if (
    !isRecord(step.evidence) ||
    !exactKeys(step.evidence, ['kind', 'schemaVersion', 'snapshots']) ||
    step.evidence.kind !== 'evidence-snapshots' ||
    step.evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    !Array.isArray(step.evidence.snapshots) ||
    step.evidence.snapshots.length !== 1
  ) {
    return;
  }
  const snapshot: unknown = step.evidence.snapshots[0];
  if (
    !isRecord(snapshot) ||
    !exactOptionalKeys(
      snapshot,
      ['kind', 'status', 'producer', 'freshness', 'coverage'],
      ['snapshotId', 'snapshotSchemaVersion', 'inputs', 'reasonCodes', 'followUpReads'],
    ) ||
    snapshot.kind !== kind ||
    typeof snapshot.status !== 'string' ||
    !EVIDENCE_STATUSES.has(snapshot.status) ||
    !isRecord(snapshot.producer) ||
    !exactKeys(snapshot.producer, ['toolId', 'command', 'version']) ||
    snapshot.producer.toolId !== GRAPH_TOOL_ID ||
    snapshot.producer.command !== command ||
    !boundedControlFreeText(snapshot.producer.version, 128) ||
    !SAFE_VERSION.test(snapshot.producer.version) ||
    !isRecord(snapshot.freshness) ||
    !exactOptionalKeys(snapshot.freshness, ['status'], ['reasonCodes']) ||
    !isRecord(snapshot.coverage) ||
    !exactOptionalKeys(snapshot.coverage, ['status'], ['items', 'total', 'reasonCodes'])
  ) {
    return;
  }
  return snapshot.status as EvidenceStatus;
}
