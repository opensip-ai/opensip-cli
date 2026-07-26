import {
  EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION,
  ValidationError,
  isPlainRecord,
  type EvidenceSnapshotContribution,
  type EvidenceSnapshotInput,
  type EvidenceSnapshotReason,
} from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

/** Registered replacement for the un-catalogued `RUN.EVIDENCE.INVALID` literal. */
const RUN_EVIDENCE_INVALID = hostErrorCatalog.require('VALIDATION.RUN_EVIDENCE.INVALID');

export const MAX_EVIDENCE_SNAPSHOT_CONTRIBUTIONS = 16;
const MAX_REASONS = 32;
const MAX_FOLLOW_UPS = 16;
const MAX_INPUTS = 16;

const STATUSES = new Set(['rebuilt', 'reused', 'partial', 'unsupported', 'failed', 'cancelled']);
const FRESHNESS = new Set(['current', 'stale', 'unknown']);
const COVERAGE = new Set(['complete', 'partial', 'unavailable']);
const SAFE_CODE = /^[a-z0-9][a-z0-9._-]*$/i;

function fail(message: string): never {
  throw new ValidationError(`Invalid evidence snapshot contribution: ${message}`, {
    code: RUN_EVIDENCE_INVALID.code,
    definition: RUN_EVIDENCE_INVALID,
  });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) fail(`${label} has unknown field '${unknown}'`);
}

function safeText(value: unknown, max: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    fail(`${label} must be a non-empty, control-free string of at most ${String(max)} characters`);
  }
  return value;
}

function code(value: unknown, label: string): string {
  const parsed = safeText(value, 128, label);
  if (!SAFE_CODE.test(parsed)) fail(`${label} must be a machine-readable code`);
  return parsed;
}

function codes(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REASONS) {
    fail(`${label} must contain at most ${String(MAX_REASONS)} reason codes`);
  }
  return Object.freeze(value.map((item, index) => code(item, `${label}[${String(index)}]`)));
}

function reasons(value: unknown): readonly EvidenceSnapshotReason[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REASONS) {
    fail(`reasons must contain at most ${String(MAX_REASONS)} entries`);
  }
  return Object.freeze(
    value.map((item, index) => {
      if (!isPlainRecord(item)) fail(`reasons[${String(index)}] must be an object`);
      exactKeys(item, ['code', 'message'], `reasons[${String(index)}]`);
      const reason = {
        code: code(item.code, `reasons[${String(index)}].code`),
        ...(item.message === undefined
          ? {}
          : {
              message: safeText(item.message, 512, `reasons[${String(index)}].message`),
            }),
      };
      return Object.freeze(reason);
    }),
  );
}

function followUps(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FOLLOW_UPS) {
    fail(`followUpReads must contain at most ${String(MAX_FOLLOW_UPS)} entries`);
  }
  return Object.freeze(value.map((item, index) => code(item, `followUpReads[${String(index)}]`)));
}

function inputs(value: unknown): readonly EvidenceSnapshotInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_INPUTS) {
    fail(`inputs must contain at most ${String(MAX_INPUTS)} entries`);
  }
  const kinds = new Set<string>();
  return Object.freeze(
    value.map((item, index) => {
      if (!isPlainRecord(item)) fail(`inputs[${String(index)}] must be an object`);
      exactKeys(item, ['kind', 'snapshotId'], `inputs[${String(index)}]`);
      const kind = code(item.kind, `inputs[${String(index)}].kind`);
      if (kinds.has(kind)) fail(`inputs contains duplicate kind '${kind}'`);
      kinds.add(kind);
      return Object.freeze({
        kind,
        snapshotId: safeText(item.snapshotId, 256, `inputs[${String(index)}].snapshotId`),
      });
    }),
  );
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function snapshotReference(
  value: Record<string, unknown>,
  index: number,
  status: string,
): Pick<EvidenceSnapshotContribution, 'snapshotId' | 'snapshotSchemaVersion'> {
  const snapshotId =
    value.snapshotId === undefined
      ? undefined
      : safeText(value.snapshotId, 256, `entry ${String(index)}.snapshotId`);
  const snapshotSchemaVersion = optionalCount(
    value.snapshotSchemaVersion,
    `entry ${String(index)}.snapshotSchemaVersion`,
  );
  if (
    (status === 'rebuilt' || status === 'reused') &&
    (snapshotId === undefined || snapshotSchemaVersion === undefined || snapshotSchemaVersion < 1)
  ) {
    fail(
      `entry ${String(index)} durable status requires snapshotId and positive snapshotSchemaVersion`,
    );
  }
  return {
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(snapshotSchemaVersion === undefined ? {} : { snapshotSchemaVersion }),
  };
}

function producer(value: unknown, index: number): EvidenceSnapshotContribution['producer'] {
  if (!isPlainRecord(value)) fail(`entry ${String(index)}.producer must be an object`);
  exactKeys(value, ['toolId', 'command', 'version'], `entry ${String(index)}.producer`);
  return Object.freeze({
    toolId: safeText(value.toolId, 214, `entry ${String(index)}.producer.toolId`),
    command: code(value.command, `entry ${String(index)}.producer.command`),
    ...(value.version === undefined
      ? {}
      : {
          version: safeText(value.version, 128, `entry ${String(index)}.producer.version`),
        }),
  });
}

function freshness(value: unknown, index: number): EvidenceSnapshotContribution['freshness'] {
  if (!isPlainRecord(value)) fail(`entry ${String(index)}.freshness must be an object`);
  exactKeys(value, ['status', 'reasonCodes'], `entry ${String(index)}.freshness`);
  if (typeof value.status !== 'string' || !FRESHNESS.has(value.status)) {
    fail(`entry ${String(index)} has unknown freshness status`);
  }
  const reasonCodes = codes(value.reasonCodes, `entry ${String(index)}.freshness.reasonCodes`);
  return Object.freeze({
    status: value.status as EvidenceSnapshotContribution['freshness']['status'],
    ...(reasonCodes === undefined ? {} : { reasonCodes }),
  });
}

function coverage(value: unknown, index: number): EvidenceSnapshotContribution['coverage'] {
  if (!isPlainRecord(value)) fail(`entry ${String(index)}.coverage must be an object`);
  exactKeys(value, ['status', 'items', 'total', 'reasonCodes'], `entry ${String(index)}.coverage`);
  if (typeof value.status !== 'string' || !COVERAGE.has(value.status)) {
    fail(`entry ${String(index)} has unknown coverage status`);
  }
  const items = optionalCount(value.items, `entry ${String(index)}.coverage.items`);
  const total = optionalCount(value.total, `entry ${String(index)}.coverage.total`);
  if (items !== undefined && total !== undefined && items > total) {
    fail(`entry ${String(index)} coverage.items cannot exceed total`);
  }
  const reasonCodes = codes(value.reasonCodes, `entry ${String(index)}.coverage.reasonCodes`);
  return Object.freeze({
    status: value.status as EvidenceSnapshotContribution['coverage']['status'],
    ...(items === undefined ? {} : { items }),
    ...(total === undefined ? {} : { total }),
    ...(reasonCodes === undefined ? {} : { reasonCodes }),
  });
}

function parseOne(value: unknown, index: number): EvidenceSnapshotContribution {
  if (!isPlainRecord(value)) fail(`entry ${String(index)} must be an object`);
  exactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'snapshotId',
      'snapshotSchemaVersion',
      'producer',
      'status',
      'freshness',
      'coverage',
      'inputs',
      'reasons',
      'followUpReads',
    ],
    `entry ${String(index)}`,
  );
  if (value.schemaVersion !== EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION) {
    fail(`entry ${String(index)} has unsupported schemaVersion`);
  }
  const kind = code(value.kind, `entry ${String(index)}.kind`);
  const status = value.status;
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    fail(`entry ${String(index)} has unknown status`);
  }
  const reference = snapshotReference(value, index, status);
  const parsedProducer = producer(value.producer, index);
  const parsedFreshness = freshness(value.freshness, index);
  const parsedCoverage = coverage(value.coverage, index);

  const parsedReasons = reasons(value.reasons);
  const parsedFollowUps = followUps(value.followUpReads);
  const parsedInputs = inputs(value.inputs);
  return Object.freeze({
    schemaVersion: EVIDENCE_SNAPSHOT_CONTRIBUTION_VERSION,
    kind,
    ...reference,
    producer: parsedProducer,
    status: status as EvidenceSnapshotContribution['status'],
    freshness: parsedFreshness,
    coverage: parsedCoverage,
    ...(parsedInputs === undefined ? {} : { inputs: parsedInputs }),
    ...(parsedReasons === undefined ? {} : { reasons: parsedReasons }),
    ...(parsedFollowUps === undefined ? {} : { followUpReads: parsedFollowUps }),
  });
}

/** Validate, copy, and freeze untrusted in-process Tool completion evidence. */
export function captureEvidenceSnapshots(value: unknown): readonly EvidenceSnapshotContribution[] {
  if (!Array.isArray(value)) fail('evidenceSnapshots must be an array');
  if (value.length > MAX_EVIDENCE_SNAPSHOT_CONTRIBUTIONS) {
    fail(`evidenceSnapshots exceeds ${String(MAX_EVIDENCE_SNAPSHOT_CONTRIBUTIONS)} entries`);
  }
  const parsed = value.map((entry, index) => parseOne(entry, index));
  const kinds = new Set<string>();
  for (const entry of parsed) {
    if (kinds.has(entry.kind)) fail(`duplicate evidence kind '${entry.kind}'`);
    kinds.add(entry.kind);
  }
  return Object.freeze(parsed);
}
