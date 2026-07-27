/** SQLite repository for immutable, bounded graph-owned context snapshots. */

import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
  projectInventorySnapshotIdentityMatches,
  projectInventorySnapshotSchema,
  testSelectionSnapshotIdentityMatches,
  testSelectionSnapshotSchema,
} from '@opensip-cli/contracts';
import {
  createToolError,
  currentLogger,
  currentScope,
  isRecord,
  ValidationError,
} from '@opensip-cli/core';
import { requireDrizzleHandle, type DrizzleDataStore } from '@opensip-cli/datastore/internal';
import { desc, eq, inArray } from 'drizzle-orm';

import { graphErrorCatalog } from '../errors/graph-error-catalog.js';

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
const SNAPSHOT_PAYLOAD_MALFORMED = graphErrorCatalog.require(
  'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED',
);

type PersistedPayloadCondition =
  | 'payload-not-json'
  | 'byte-count-mismatch'
  | 'inventory-schema-invalid'
  | 'inventory-row-id-mismatch'
  | 'inventory-identity-mismatch'
  | 'test-selection-schema-invalid'
  | 'test-selection-row-id-mismatch'
  | 'test-selection-identity-mismatch';

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

function malformedPersistedPayload(condition: PersistedPayloadCondition, cause?: unknown): Error {
  return createToolError(
    SNAPSHOT_PAYLOAD_MALFORMED,
    'Stored graph context snapshot payload is malformed.',
    {
      ...(cause === undefined ? {} : { cause }),
      metadata: { condition },
    },
  );
}

/** @throws {Error} When the stored inventory shape, row binding, or identity is invalid. */
function validatedInventoryPayload(row: SnapshotRow): unknown {
  const parsed = projectInventorySnapshotSchema.safeParse(row.payload);
  if (!parsed.success) throw malformedPersistedPayload('inventory-schema-invalid');
  if (parsed.data.snapshotId !== row.id) {
    throw malformedPersistedPayload('inventory-row-id-mismatch');
  }
  if (!projectInventorySnapshotIdentityMatches(parsed.data)) {
    throw malformedPersistedPayload('inventory-identity-mismatch');
  }
  return parsed.data;
}

/** @throws {Error} When the stored test-selection shape, row binding, or identity is invalid. */
function validatedTestSelectionPayload(row: SnapshotRow): unknown {
  const parsed = testSelectionSnapshotSchema.safeParse(row.payload);
  if (!parsed.success) throw malformedPersistedPayload('test-selection-schema-invalid');
  if (parsed.data.snapshotId !== row.id) {
    throw malformedPersistedPayload('test-selection-row-id-mismatch');
  }
  if (!testSelectionSnapshotIdentityMatches(parsed.data)) {
    throw malformedPersistedPayload('test-selection-identity-mismatch');
  }
  return parsed.data;
}

/**
 * Re-establish the immutable payload proof at the persistence boundary.
 *
 * Future schema versions remain opaque so the public reader can report `unsupported-version`;
 * current schemas must prove shape, row binding, and their content-derived snapshot identity.
 *
 * @throws {Error} When a current-version payload fails encoding, byte-count, shape, or identity
 *   validation.
 */
function validatedPersistedPayload(row: SnapshotRow): unknown {
  let encoded: string;
  try {
    encoded = canonicalJson(row.payload);
  } catch (error) {
    throw malformedPersistedPayload('payload-not-json', error);
  }
  if (Buffer.byteLength(encoded, 'utf8') !== row.byteCount) {
    throw malformedPersistedPayload('byte-count-mismatch');
  }

  if (row.kind === 'inventory' && row.schemaVersion === PROJECT_INVENTORY_SCHEMA_VERSION) {
    return validatedInventoryPayload(row);
  }

  if (row.kind === 'test-selection' && row.schemaVersion === TEST_SELECTION_SCHEMA_VERSION) {
    return validatedTestSelectionPayload(row);
  }

  return row.payload;
}

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
    payload: validatedPersistedPayload(row),
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

  save(
    input: ContextSnapshotSaveInput,
    retentionProtectedIds: readonly string[] = [],
  ): ContextSnapshotSaveResult {
    const started = Date.now();
    const log = currentLogger();
    try {
      const validated = validateInput(input);
      const protectedIds = new Set([input.id, ...retentionProtectedIds]);
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
          const pruned = this.pruneInTransaction(tx, protectedIds);
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

  private pruneInTransaction(
    tx: DrizzleDataStore['db'],
    protectedIds: ReadonlySet<string>,
  ): readonly PruneSummary[] {
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
      this.pruneKindInTransaction(tx, kind, protectedIds, recordRemoval);
    }
    this.pruneTotalBytesInTransaction(tx, protectedIds, recordRemoval);
    return [...removed.entries()]
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([kind, summary]) => ({
        kind,
        rowsRemoved: summary.rows,
        bytesRemoved: summary.bytes,
      }));
  }

  /**
   * @throws {ValidationError} When protected snapshots alone exceed the per-kind retention limit.
   */
  private pruneKindInTransaction(
    tx: DrizzleDataStore['db'],
    kind: string,
    protectedIds: ReadonlySet<string>,
    recordRemoval: (kind: string, rows: number, bytes: number) => void,
  ): void {
    const rowsForKind = tx
      .select({ id: graphContextSnapshot.id, byteCount: graphContextSnapshot.byteCount })
      .from(graphContextSnapshot)
      .where(eq(graphContextSnapshot.kind, kind))
      .orderBy(desc(graphContextSnapshot.createdAt), desc(graphContextSnapshot.id))
      .all();
    const retained = new Set(
      rowsForKind.filter((row) => protectedIds.has(row.id)).map((row) => row.id),
    );
    if (retained.size > MAX_CONTEXT_SNAPSHOTS_PER_KIND) {
      throw validation(
        'Protected context snapshots exceed the per-kind retention limit.',
        'GRAPH.CONTEXT_SNAPSHOT.RETENTION',
      );
    }
    for (const row of rowsForKind) {
      if (retained.size >= MAX_CONTEXT_SNAPSHOTS_PER_KIND) break;
      retained.add(row.id);
    }
    const overflow = rowsForKind.filter((row) => !retained.has(row.id));
    if (overflow.length === 0) return;
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

  /**
   * @throws {ValidationError} When protected snapshots alone exceed the aggregate byte limit.
   */
  private pruneTotalBytesInTransaction(
    tx: DrizzleDataStore['db'],
    protectedIds: ReadonlySet<string>,
    recordRemoval: (kind: string, rows: number, bytes: number) => void,
  ): void {
    const rows = tx
      .select({
        id: graphContextSnapshot.id,
        kind: graphContextSnapshot.kind,
        byteCount: graphContextSnapshot.byteCount,
      })
      .from(graphContextSnapshot)
      .orderBy(desc(graphContextSnapshot.createdAt), desc(graphContextSnapshot.id))
      .all();
    let bytes = rows
      .filter((row) => protectedIds.has(row.id))
      .reduce((total, row) => total + row.byteCount, 0);
    if (bytes > MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES) {
      throw validation(
        'Protected context snapshots exceed the total retention limit.',
        'GRAPH.CONTEXT_SNAPSHOT.RETENTION',
      );
    }
    const remove: string[] = [];
    for (const row of rows) {
      if (protectedIds.has(row.id)) continue;
      if (bytes + row.byteCount <= MAX_CONTEXT_SNAPSHOT_TOTAL_BYTES) {
        bytes += row.byteCount;
      } else {
        remove.push(row.id);
      }
    }
    if (remove.length === 0) return;
    const removedIds = new Set(remove);
    tx.delete(graphContextSnapshot).where(inArray(graphContextSnapshot.id, remove)).run();
    for (const row of rows) {
      if (removedIds.has(row.id)) recordRemoval(row.kind, 1, row.byteCount);
    }
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
    save: (input: ContextSnapshotSaveInput) =>
      currentRepo().save(input, currentScope()?.graph?.contextRun.protectedSnapshotIds ?? []),
    get: (id: string) => currentRepo().get(id),
    latest: (kind: string) => currentRepo().latest(kind),
  });
}
