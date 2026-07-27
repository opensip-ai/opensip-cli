/** Public graph/read projection for immutable context snapshots. */

import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
  projectInventorySnapshotIdentityMatches,
  projectInventorySnapshotSchema,
  testSelectionSnapshotIdentityMatches,
  testSelectionSnapshotSchema,
} from '@opensip-cli/contracts';
import { ok, type Result } from '@opensip-cli/core';

import { ContextSnapshotRepo } from '../persistence/context-snapshot-repo.js';

import { failGraphRead } from './read-boundary-failure.js';

import type { GraphReadError } from './types.js';
import type { ContextSnapshotPayload, ContextSnapshotRecord } from '../context-snapshot-types.js';
import type { DataStore } from '@opensip-cli/datastore';

export type {
  ContextSnapshotAccessor,
  ContextSnapshotKind,
  ContextSnapshotPayload,
  ContextSnapshotRecord,
  ContextSnapshotSaveInput,
  ContextSnapshotSaveResult,
} from '../context-snapshot-types.js';

/**
 * Exact-ID context snapshot lookup result, distinguishing eviction/missing data,
 * unsupported stored schema versions, and validated immutable payloads.
 */
export type ContextSnapshotLookup =
  | { readonly status: 'missing'; readonly id: string }
  | {
      readonly status: 'unsupported-version';
      readonly id: string;
      readonly kind: string;
      readonly schemaVersion: number;
    }
  | {
      readonly status: 'available';
      readonly snapshot: ContextSnapshotRecord & {
        readonly payload: ContextSnapshotPayload;
      };
    };

/** @throws {Error} When a stored snapshot payload fails schema or identity verification. */
function decode(record: ContextSnapshotRecord): ContextSnapshotLookup {
  if (record.kind === 'inventory') {
    if (record.schemaVersion !== PROJECT_INVENTORY_SCHEMA_VERSION) {
      return {
        status: 'unsupported-version',
        id: record.id,
        kind: record.kind,
        schemaVersion: record.schemaVersion,
      };
    }
    const parsed = projectInventorySnapshotSchema.safeParse(record.payload);
    if (
      !parsed.success ||
      parsed.data.snapshotId !== record.id ||
      !projectInventorySnapshotIdentityMatches(parsed.data)
    ) {
      throw new Error('invalid payload');
    }
    return {
      status: 'available',
      snapshot: { ...record, payload: parsed.data },
    };
  }
  if (record.kind === 'test-selection') {
    if (record.schemaVersion !== TEST_SELECTION_SCHEMA_VERSION) {
      return {
        status: 'unsupported-version',
        id: record.id,
        kind: record.kind,
        schemaVersion: record.schemaVersion,
      };
    }
    const parsed = testSelectionSnapshotSchema.safeParse(record.payload);
    if (
      !parsed.success ||
      parsed.data.snapshotId !== record.id ||
      !testSelectionSnapshotIdentityMatches(parsed.data)
    ) {
      throw new Error('invalid payload');
    }
    return {
      status: 'available',
      snapshot: { ...record, payload: parsed.data },
    };
  }
  return {
    status: 'unsupported-version',
    id: record.id,
    kind: record.kind,
    schemaVersion: record.schemaVersion,
  };
}

/** Exact-ID lookup. Missing/evicted rows never rebind to latest. */
export function readContextSnapshot(
  store: DataStore,
  id: string,
): Result<ContextSnapshotLookup, GraphReadError> {
  try {
    const record = new ContextSnapshotRepo(store).get(id);
    return ok(record === null ? { status: 'missing', id } : decode(record));
  } catch (error) {
    return failGraphRead(error, {
      boundary: 'infrastructure',
      condition: 'context-snapshot',
      module: 'graph:read:context-snapshot',
      reason: 'context-snapshot',
      operation: 'catalog-generation',
      message: 'Failed to read or decode graph context snapshot',
    });
  }
}
