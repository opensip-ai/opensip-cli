import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';

import { MAX_AGENT_GUIDANCE_FILE_BYTES } from './agent-guidance-renderer.js';
import { listAgentGuidanceTargetSpecs } from './agent-guidance.js';
import {
  INIT_AUTHORED_PLAN_CAPS,
  authoredPlanFailure,
  caseFoldPath,
  compareUtf8,
  directoryDigest,
  normalizeProjectRelativePath,
  sha256Bytes,
} from './init-authored-plan-types.js';

import type { AgentGuidanceTargetSnapshot } from './agent-guidance.js';
import type { InitAuthoredSnapshotRecord } from './init-authored-plan-types.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeBase64(value: string, field: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    authoredPlanFailure(`${field} is noncanonical base64`);
  }
  return bytes;
}

export function decodeSnapshotUtf8(record: InitAuthoredSnapshotRecord, field: string): string {
  if (!record.exists || record.type !== 'file') {
    authoredPlanFailure(`${field} must be a file`);
  }
  const bytes = decodeBase64(record.contentBase64, `${field}.contentBase64`);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    authoredPlanFailure(`${field} is not valid UTF-8`);
  }
}

export function buildGuidanceSnapshots(
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
): readonly AgentGuidanceTargetSnapshot[] {
  return listAgentGuidanceTargetSpecs().map((spec) => {
    const record = preimages.get(spec.relativePath);
    if (record === undefined) {
      authoredPlanFailure(`snapshot is missing ${spec.relativePath}`);
    }
    if (!record.exists) {
      const parent = dirname(spec.relativePath).replaceAll('\\', '/');
      const parentRecord = parent === '.' ? undefined : preimages.get(parent);
      return {
        relativePath: spec.relativePath,
        status: 'missing',
        parentExists:
          parent === '.' || (parentRecord?.exists === true && parentRecord.type === 'directory'),
      };
    }
    if (record.type !== 'file') {
      authoredPlanFailure(`${spec.relativePath} must be a file`);
    }
    if (Buffer.from(record.contentBase64, 'base64').length > MAX_AGENT_GUIDANCE_FILE_BYTES) {
      authoredPlanFailure(`${spec.relativePath} exceeds the managed guidance cap`);
    }
    return {
      relativePath: spec.relativePath,
      status: 'present',
      content: decodeSnapshotUtf8(record, spec.relativePath),
    };
  });
}

function validateAbsentRecord(
  record: Extract<InitAuthoredSnapshotRecord, { readonly exists: false }>,
): void {
  if (
    record.type !== null ||
    record.mode !== null ||
    record.digest !== null ||
    record.contentBase64 !== null
  ) {
    authoredPlanFailure(`${record.path} has an invalid absent snapshot`);
  }
}

function validateExistingIdentity(
  record: Extract<InitAuthoredSnapshotRecord, { readonly exists: true }>,
): void {
  if (
    !Number.isInteger(record.mode) ||
    record.mode < 0 ||
    record.mode > 0o777 ||
    (record.mode & 0o022) !== 0 ||
    !/^[a-f0-9]{64}$/u.test(record.digest)
  ) {
    authoredPlanFailure(`${record.path} has an invalid snapshot identity`);
  }
}

function validateExistingRecord(
  record: Extract<InitAuthoredSnapshotRecord, { readonly exists: true }>,
): number {
  validateExistingIdentity(record);
  if (record.type === 'directory') {
    if (record.contentBase64 !== null || record.digest !== directoryDigest(record.mode)) {
      authoredPlanFailure(`${record.path} has an invalid directory snapshot`);
    }
    return 0;
  }
  const bytes = decodeBase64(record.contentBase64, `${record.path}.contentBase64`);
  if (bytes.length > INIT_AUTHORED_PLAN_CAPS.maxFileBytes) {
    authoredPlanFailure(`${record.path} exceeds the authored file cap`);
  }
  if (sha256Bytes(bytes) !== record.digest) {
    authoredPlanFailure(`${record.path} content disagrees with its digest`);
  }
  return bytes.length;
}

function validateRecord(record: InitAuthoredSnapshotRecord): number {
  if (record.exists) return validateExistingRecord(record);
  validateAbsentRecord(record);
  return 0;
}

export function validateAuthoredSnapshot(
  records: readonly InitAuthoredSnapshotRecord[],
): ReadonlyMap<string, InitAuthoredSnapshotRecord> {
  if (records.length > INIT_AUTHORED_PLAN_CAPS.maxTraversalEntries) {
    authoredPlanFailure('snapshot record count exceeds the traversal cap');
  }
  const indexed = new Map<string, InitAuthoredSnapshotRecord>();
  const folded = new Set<string>();
  let aggregateBytes = 0;
  for (const [index, record] of records.entries()) {
    const path = normalizeProjectRelativePath(record.path);
    if (index > 0 && compareUtf8(records[index - 1].path, path) >= 0) {
      authoredPlanFailure('snapshot records are not in canonical UTF-8 path order');
    }
    const caseFolded = caseFoldPath(path);
    if (folded.has(caseFolded)) {
      authoredPlanFailure('snapshot paths collide under case folding');
    }
    folded.add(caseFolded);
    aggregateBytes += validateRecord(record);
    indexed.set(path, record);
  }
  if (aggregateBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
    authoredPlanFailure('snapshot content exceeds the aggregate content cap');
  }
  return indexed;
}
