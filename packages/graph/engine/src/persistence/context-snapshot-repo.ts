/** SQLite repository for immutable, bounded graph-owned context snapshots. */

import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
  projectInventorySnapshotIdentityMatches,
  projectInventorySnapshotSchema,
  testSelectionSnapshotIdentityMatches,
  testSelectionSnapshotSchema,
} from '@opensip-cli/contracts';
import { currentLogger, currentScope, isRecord, ValidationError } from '@opensip-cli/core';
import { requireDrizzleHandle, type DrizzleDataStore } from '@opensip-cli/datastore/internal';
import { desc, eq, inArray } from 'drizzle-orm';

import { graphContextSnapshot } from './schema.js';

import type {
  ContextSnapshotAccessor,
  ContextSnapshotRecord,
  ContextSnapshotSaveInput,
  ContextSnapshotSaveResult,
} from '../context-snapshot-types.js';
import type { DataStore } from '@opensip-cli/datastore';

export const MAX_CONTEXT_SNAPSHOT_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_CONTEXT_SNAPSHOTS_PER_KIND = 3;
export const MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES = 24 * 1024 * 1024;

const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_SNAPSHOT_CODE = 'GRAPH.CONTEXT_SNAPSHOT.INVALID';
const MODULE_NAME = 'graph:context-snapshot-repo';

interface PruneSummary {
  readonly kind: string;
  readonly rowsRemoved: number;
  readonly bytesRemoved: number;
}

function validation(message: string, code: string): ValidationError {
  return new ValidationError(message, { code });
}

function safeLogCode(value: string): string {
  return value.length <= 128 && SAFE_CODE.test(value) ? value : 'invalid';
}

/** @throws {ValidationError} When the value is not bounded control-free text. */
function safeText(value: unknown, max: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw validation(`${label} is invalid or oversized.`, INVALID_SNAPSHOT_CODE);
  }
  return value;
}

/** @throws {ValidationError} When the payload cannot be encoded as canonical JSON. */
function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item) || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => compareKeys(left, right)),
    );
  });
  if (encoded === undefined) {
    throw validation('Context snapshot payload must be JSON serializable.', INVALID_SNAPSHOT_CODE);
  }
  return encoded;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** @throws {ValidationError} When payload identity, schema, kind, or byte bounds are invalid. */
function validatePayload(input: ContextSnapshotSaveInput): string {
  if (!SAFE_CODE.test(safeText(input.kind, 128, 'Context snapshot kind'))) {
    throw validation('Context snapshot kind is invalid.', INVALID_SNAPSHOT_CODE);
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw validation('Context snapshot schema version is invalid.', INVALID_SNAPSHOT_CODE);
  }
  // Apply the hard byte bound before walking the payload through a schema. This
  // keeps an oversized, deeply nested candidate from consuming validation work
  // even though it can never be admitted to storage.
  const encoded = canonicalJson(input.payload);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > MAX_CONTEXT_SNAPSHOT_PAYLOAD_BYTES) {
    throw validation(
      'Context snapshot payload exceeds the 8 MiB limit.',
      'GRAPH.CONTEXT_SNAPSHOT.OVERSIZED',
    );
  }
  if (input.kind === 'inventory') {
    const parsed = projectInventorySnapshotSchema.safeParse(input.payload);
    if (
      input.schemaVersion !== PROJECT_INVENTORY_SCHEMA_VERSION ||
      !parsed.success ||
      parsed.data.snapshotId !== input.id ||
      !projectInventorySnapshotIdentityMatches(parsed.data)
    ) {
      throw validation('Project inventory snapshot payload is malformed.', INVALID_SNAPSHOT_CODE);
    }
  } else if (input.kind === 'test-selection') {
    const parsed = testSelectionSnapshotSchema.safeParse(input.payload);
    if (
      input.schemaVersion !== TEST_SELECTION_SCHEMA_VERSION ||
      !parsed.success ||
      parsed.data.snapshotId !== input.id ||
      !testSelectionSnapshotIdentityMatches(parsed.data)
    ) {
      throw validation('Test selection snapshot payload is malformed.', INVALID_SNAPSHOT_CODE);
    }
  } else {
    throw validation('Context snapshot kind is unsupported.', 'GRAPH.CONTEXT_SNAPSHOT.UNSUPPORTED');
  }
  return encoded;
}

/** @throws {ValidationError} When snapshot metadata or its payload is invalid. */
function validateInput(input: ContextSnapshotSaveInput): {
  readonly encoded: string;
  readonly bytes: number;
} {
  safeText(input.id, 256, 'Context snapshot ID');
  safeText(input.producerVersion, 128, 'Context snapshot producer version');
  safeText(input.sourceIdentity, 256, 'Context snapshot source identity');
  safeText(input.configIdentity, 256, 'Context snapshot config identity');
  safeText(input.createdAt, 64, 'Context snapshot created time');
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== input.createdAt) {
    throw validation('Context snapshot created time is invalid.', INVALID_SNAPSHOT_CODE);
  }
  const encoded = validatePayload(input);
  return { encoded, bytes: Buffer.byteLength(encoded, 'utf8') };
}

type SnapshotRow = typeof graphContextSnapshot.$inferSelect;

function fromRow(row: SnapshotRow): ContextSnapshotRecord {
  return {
    id: row.id,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    producerVersion: row.producerVersion,
    createdAt: row.createdAt,
    sourceIdentity: row.sourceIdentity,
    configIdentity: row.configIdentity,
    byteCount: row.byteCount,
    payload: row.payload,
  };
}

function sameSnapshot(row: SnapshotRow, input: ContextSnapshotSaveInput, encoded: string): boolean {
  return (
    row.kind === input.kind &&
    row.schemaVersion === input.schemaVersion &&
    row.sourceIdentity === input.sourceIdentity &&
    row.configIdentity === input.configIdentity &&
    row.byteCount === Buffer.byteLength(encoded, 'utf8') &&
    canonicalJson(row.payload) === encoded
  );
}

/** Concrete repository; only graph persistence/read files import this class. */
export class ContextSnapshotRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleHandle(datastore);
  }

  save(input: ContextSnapshotSaveInput): ContextSnapshotSaveResult {
    const started = Date.now();
    const log = currentLogger();
    try {
      const validated = validateInput(input);
      const outcome = this.datastore.withWriteLock('graph.context_snapshot.save', () =>
        this.datastore.transaction((tx) => {
          const existing = tx
            .select()
            .from(graphContextSnapshot)
            .where(eq(graphContextSnapshot.id, input.id))
            .get();
          if (existing !== undefined) {
            if (!sameSnapshot(existing, input, validated.encoded)) {
              throw validation(
                'Context snapshot ID already names different immutable content.',
                'GRAPH.CONTEXT_SNAPSHOT.CONFLICT',
              );
            }
            return {
              result: { status: 'reused' as const, snapshot: fromRow(existing) },
              pruned: [] as readonly PruneSummary[],
            };
          }
          tx.insert(graphContextSnapshot)
            .values({
              id: input.id,
              kind: input.kind,
              schemaVersion: input.schemaVersion,
              producerVersion: input.producerVersion,
              createdAt: input.createdAt,
              sourceIdentity: input.sourceIdentity,
              configIdentity: input.configIdentity,
              byteCount: validated.bytes,
              payload: input.payload,
            })
            .run();
          const pruned = this.pruneInTransaction(tx);
          const saved = tx
            .select()
            .from(graphContextSnapshot)
            .where(eq(graphContextSnapshot.id, input.id))
            .get();
          if (saved === undefined) {
            throw validation(
              'Context snapshot could not be retained within bounded storage.',
              'GRAPH.CONTEXT_SNAPSHOT.RETENTION',
            );
          }
          return {
            result: { status: 'rebuilt' as const, snapshot: fromRow(saved) },
            pruned,
          };
        }),
      );
      log.info({
        evt:
          outcome.result.status === 'reused'
            ? 'graph.context.snapshot.reused'
            : 'graph.context.snapshot.saved',
        module: MODULE_NAME,
        kind: input.kind,
        schemaVersion: input.schemaVersion,
        byteCount: outcome.result.snapshot.byteCount,
        durationMs: Date.now() - started,
      });
      for (const summary of outcome.pruned) {
        log.info({
          evt: 'graph.context.snapshot.pruned',
          module: MODULE_NAME,
          kind: summary.kind,
          rowsRemoved: summary.rowsRemoved,
          bytesRemoved: summary.bytesRemoved,
        });
      }
      return outcome.result;
    } catch (error) {
      log.error({
        evt: 'graph.context.snapshot.failed',
        module: MODULE_NAME,
        kind: safeLogCode(input.kind),
        schemaVersion: Number.isSafeInteger(input.schemaVersion) ? input.schemaVersion : 0,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  get(id: string): ContextSnapshotRecord | null {
    safeText(id, 256, 'Context snapshot ID');
    const row = this.datastore.db
      .select()
      .from(graphContextSnapshot)
      .where(eq(graphContextSnapshot.id, id))
      .get();
    return row === undefined ? null : fromRow(row);
  }

  /** @throws {ValidationError} When the requested snapshot kind is invalid. */
  latest(kind: string): ContextSnapshotRecord | null {
    if (!SAFE_CODE.test(safeText(kind, 128, 'Context snapshot kind'))) {
      throw validation('Context snapshot kind is invalid.', INVALID_SNAPSHOT_CODE);
    }
    const row = this.datastore.db
      .select()
      .from(graphContextSnapshot)
      .where(eq(graphContextSnapshot.kind, kind))
      .orderBy(desc(graphContextSnapshot.createdAt), desc(graphContextSnapshot.id))
      .limit(1)
      .get();
    return row === undefined ? null : fromRow(row);
  }

  private pruneInTransaction(tx: DrizzleDataStore['db']): readonly PruneSummary[] {
    const removed = new Map<string, { rows: number; bytes: number }>();
    const recordRemoval = (kind: string, rows: number, bytes: number): void => {
      const current = removed.get(kind) ?? { rows: 0, bytes: 0 };
      removed.set(kind, { rows: current.rows + rows, bytes: current.bytes + bytes });
    };
    const kinds = tx
      .select({ kind: graphContextSnapshot.kind })
      .from(graphContextSnapshot)
      .groupBy(graphContextSnapshot.kind)
      .all();
    for (const { kind } of kinds) {
      const overflow = tx
        .select({ id: graphContextSnapshot.id, byteCount: graphContextSnapshot.byteCount })
        .from(graphContextSnapshot)
        .where(eq(graphContextSnapshot.kind, kind))
        .orderBy(desc(graphContextSnapshot.createdAt), desc(graphContextSnapshot.id))
        .limit(Number.MAX_SAFE_INTEGER)
        .offset(MAX_CONTEXT_SNAPSHOTS_PER_KIND)
        .all();
      if (overflow.length > 0) {
        tx.delete(graphContextSnapshot)
          .where(
            inArray(
              graphContextSnapshot.id,
              overflow.map((row) => row.id),
            ),
          )
          .run();
        recordRemoval(
          kind,
          overflow.length,
          overflow.reduce((total, row) => total + row.byteCount, 0),
        );
      }
    }
    const rows = tx
      .select({
        id: graphContextSnapshot.id,
        kind: graphContextSnapshot.kind,
        byteCount: graphContextSnapshot.byteCount,
      })
      .from(graphContextSnapshot)
      .orderBy(desc(graphContextSnapshot.createdAt), desc(graphContextSnapshot.id))
      .all();
    let bytes = 0;
    const remove: string[] = [];
    for (const row of rows) {
      bytes += row.byteCount;
      if (bytes > MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES) remove.push(row.id);
    }
    if (remove.length > 0) {
      tx.delete(graphContextSnapshot).where(inArray(graphContextSnapshot.id, remove)).run();
      for (const row of rows) {
        if (remove.includes(row.id)) recordRemoval(row.kind, 1, row.byteCount);
      }
    }
    return [...removed.entries()]
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([kind, summary]) => ({
        kind,
        rowsRemoved: summary.rows,
        bytesRemoved: summary.bytes,
      }));
  }
}

/** @throws {ValidationError} When no entered RunScope supplies a project datastore. */
function currentRepo(): ContextSnapshotRepo {
  const datastore = currentScope()?.datastore() as DataStore | undefined;
  if (datastore === undefined) {
    throw validation(
      'Context snapshot persistence requires an entered project datastore.',
      'GRAPH.CONTEXT_SNAPSHOT.DATASTORE_REQUIRED',
    );
  }
  return new ContextSnapshotRepo(datastore);
}

/** Lazy structural accessor installed on the graph RunScope contribution. */
export function createContextSnapshotAccessor(): ContextSnapshotAccessor {
  return Object.freeze({
    save: (input: ContextSnapshotSaveInput) => currentRepo().save(input),
    get: (id: string) => currentRepo().get(id),
    latest: (kind: string) => currentRepo().latest(kind),
  });
}
