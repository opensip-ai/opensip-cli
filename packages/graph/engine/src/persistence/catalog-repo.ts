/**
 * CatalogRepo — SQLite-backed graph catalog at parity with v1's
 * single-JSON-file shape.
 *
 * v1 stored the catalog as `<runtime>/cache/graph/catalog.json`. v2
 * stores it in `graph_catalog` row 1, lifting the cache-validity
 * fields (language, cacheKey, filesFingerprint) into typed columns so
 * the orchestrator can fingerprint-mismatch without parsing the full
 * payload. The catalog perf follow-up plan normalizes the payload
 * into per-function/occurrence/edge tables and pushes dashboard view
 * derivations into SQL.
 */

import { isRecord, logger } from '@opensip-cli/core';
import { requireDrizzleHandle, type DrizzleDataStore } from '@opensip-cli/datastore/internal';
import { sql } from 'drizzle-orm';

import { isSafeShardedCacheAnchor } from '../cache/sharded-cache-key.js';
import { graphErrorCatalog } from '../errors/graph-error-catalog.js';
import { CALL_EDGE_TEXT_MAX } from '../lang-adapter/edge-helpers.js';
import { isValidDependencyFormRole } from '../types.js';

import { graphCatalog, graphShardFragment } from './schema.js';
import { validateSemanticFactBundle } from './semantic-fact-payload.js';

import type { ShardBuildResult } from '../cli/orchestrate/shard-model.js';
import type {
  AdapterSelectionEvidence,
  Catalog,
  CatalogEngineMode,
  PersistedFeatures,
  ResolutionMode,
} from '../types.js';
import type { GraphCatalog } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.
const CATALOG_UNREADABLE = graphErrorCatalog.require('GRAPH.CATALOG.UNREADABLE');

const MODULE_NAME = 'graph:catalog-repo';

// Per-process validated-identity memo for the trusted warm-read gate (plan 09
// Task 6.1). A validation FACT cache (content-keyed, idempotent) — not run
// state: keyed by the datastore handle (WeakMap — dies with the store) and
// bounded per store.
const VALIDATED_CATALOG_IDENTITIES = new WeakMap<object, Set<string>>();
const MAX_VALIDATED_IDENTITIES = 4;

// Error-log cause bound (message only, no stack: the public-read-surface
// privacy test forbids backend vocabulary like module paths in this log).
const MAX_ERR_CHARS = 300;

/** Length-bounded error cause for the catalog error events. */
function boundedErrorCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERR_CHARS ? `${message.slice(0, MAX_ERR_CHARS)}…` : message;
}

const MAX_ADAPTER_ID = 64;
const MAX_SHARD_INPUTS = 10_000;
const MAX_SHARD_ID = 256;
const MAX_SHARD_TEXT = 4096;
const MAX_CATALOG_TEXT = 8192;
const MAX_FUNCTION_BUCKETS = 1_000_000;
const MAX_OCCURRENCES = 2_000_000;
const MAX_EDGES_PER_OCCURRENCE = 100_000;
const MAX_NESTED_EDGES = 5_000_000;
const MAX_TARGETS_PER_EDGE = 10_000;
const MAX_NESTED_TARGETS = 10_000_000;
const MAX_BOUNDARY_CALLS = 5_000_000;
const MAX_PARSE_ERRORS = 1_000_000;
const MAX_FINGERPRINT = 64 * 1024 * 1024;
const ADAPTER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;

interface CatalogRowPayload {
  readonly version: '3.0';
  readonly tool: 'graph';
  readonly language: string;
  readonly builtAt: string;
  readonly cacheKey: string;
  readonly filesFingerprint?: string;
  /**
   * The resolution tier that built this catalog. Stored in the JSON
   * payload (no schema column needed) so a loaded catalog self-describes
   * its tier on cache hits — consumers (report banner, lookup note, gate
   * refusal, rule caveats) stay honest on warm runs, not just fresh
   * builds. Absent ⇒ exact (catalogs persisted before fast mode landed).
   */
  readonly resolutionMode?: ResolutionMode;
  /** Optional adapter-selection provenance (no migration; payload-only). */
  readonly adapterSelection?: AdapterSelectionEvidence;
  /** Optional exact vs sharded engine mode (no migration; payload-only). */
  readonly engineMode?: CatalogEngineMode;
  /** Optional project-relative sharded cache inputs (no migration; payload-only). */
  readonly shardCacheInputs?: Catalog['shardCacheInputs'];
  /** Optional bounded build coverage (absent on legacy catalogs). */
  readonly buildCoverage?: Catalog['buildCoverage'];
  readonly functions: Catalog['functions'];
  /**
   * Re-export facts (re-export-chain resolution). Present only when the adapter
   * emitted them; omitted otherwise so lean payloads stay byte-unchanged. MUST
   * round-trip so a warm (cached) build's catalog equals the cold one.
   */
  readonly reExports?: Catalog['reExports'];
  /**
   * Optional semantic declaration/reference plane (P2 Phase 3). Absent =
   * unsupported; present (including empty arrays) round-trips unchanged.
   */
  readonly semanticFacts?: Catalog['semanticFacts'];
  /**
   * Materialized dashboard columns (ADR-0006); present ONLY when the producing
   * run requested `emitFeatures`. A lean default run omits this key entirely,
   * so the stored payload stays byte-unchanged for non-dashboard builds.
   */
  readonly features?: PersistedFeatures;
}

function isSafeAdapterId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ADAPTER_ID &&
    ADAPTER_ID.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}

function isSafeAdapterSelection(value: unknown): value is AdapterSelectionEvidence {
  if (!isRecord(value) || !isSafeAdapterId(value.selectedId)) return false;
  if (value.mode === 'auto') return Object.keys(value).length === 2;
  return (
    value.mode === 'forced' && isSafeAdapterId(value.requestedId) && Object.keys(value).length === 3
  );
}

function isSafeShardId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SHARD_ID &&
    !/\p{Cc}/u.test(value)
  );
}

function isSafeShardCacheInputs(value: unknown): value is NonNullable<Catalog['shardCacheInputs']> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SHARD_INPUTS) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry) || !isSafeShardId(entry.shardId) || ids.has(entry.shardId)) return false;
    const keys = Object.keys(entry);
    if (
      !keys.includes('shardId') ||
      !keys.includes('rootDir') ||
      keys.some((key) => key !== 'shardId' && key !== 'rootDir' && key !== 'configPath') ||
      !isSafeShardedCacheAnchor(entry.rootDir, MAX_SHARD_TEXT)
    ) {
      return false;
    }
    if (
      entry.configPath !== undefined &&
      !isSafeShardedCacheAnchor(entry.configPath, MAX_SHARD_TEXT)
    ) {
      return false;
    }
    ids.add(entry.shardId);
    return true;
  });
}

/**
 * Validate optional engine and adapter provenance attached to a catalog payload.
 *
 * @throws {Error} when any supplied provenance field is malformed.
 */
function validateOptionalProvenance(payload: Record<string, unknown>): void {
  if (payload.adapterSelection !== undefined && !isSafeAdapterSelection(payload.adapterSelection)) {
    throw new Error('Malformed catalog adapter-selection provenance');
  }
  if (
    payload.engineMode !== undefined &&
    payload.engineMode !== 'exact' &&
    payload.engineMode !== 'sharded'
  ) {
    throw new Error('Malformed catalog engine-mode provenance');
  }
  if (payload.shardCacheInputs !== undefined && !isSafeShardCacheInputs(payload.shardCacheInputs)) {
    throw new Error('Malformed catalog shard-cache provenance');
  }
  if (
    payload.buildCoverage !== undefined &&
    (!isRecord(payload.buildCoverage) ||
      Object.keys(payload.buildCoverage).some(
        (key) =>
          key !== 'status' &&
          key !== 'discoveredFiles' &&
          key !== 'parseErrorFiles' &&
          key !== 'filesIdentity',
      ) ||
      (payload.buildCoverage.status !== 'complete' && payload.buildCoverage.status !== 'partial') ||
      !Number.isSafeInteger(payload.buildCoverage.discoveredFiles) ||
      (payload.buildCoverage.discoveredFiles as number) < 0 ||
      !Number.isSafeInteger(payload.buildCoverage.parseErrorFiles) ||
      (payload.buildCoverage.parseErrorFiles as number) < 0 ||
      (payload.buildCoverage.parseErrorFiles as number) >
        (payload.buildCoverage.discoveredFiles as number) ||
      typeof payload.buildCoverage.filesIdentity !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(payload.buildCoverage.filesIdentity))
  ) {
    throw new Error('Malformed catalog build coverage');
  }
}

/**
 * Cheap top-level integrity gate: envelope shape, version, provenance,
 * coverage, and the (self-degrading) semantic-fact plane. O(1) in the
 * function-container count — this ALWAYS runs on read, so a genuinely corrupt
 * or wrong-generation row still fails loud even on the trusted fast path.
 *
 * @throws {Error} when the payload shape or provenance is invalid.
 */
function validateCatalogShape(value: unknown): asserts value is CatalogRowPayload {
  if (!isRecord(value)) throw new Error('Malformed catalog payload');
  if (
    value.version !== '3.0' ||
    value.tool !== 'graph' ||
    !isSafeAdapterId(value.language) ||
    !isSafeCatalogText(value.builtAt) ||
    !isSafeCatalogText(value.cacheKey) ||
    (value.filesFingerprint !== undefined &&
      (typeof value.filesFingerprint !== 'string' ||
        value.filesFingerprint.length > MAX_FINGERPRINT)) ||
    (value.resolutionMode !== undefined &&
      value.resolutionMode !== 'exact' &&
      value.resolutionMode !== 'fast') ||
    !isRecord(value.functions)
  ) {
    throw new Error('Malformed catalog payload');
  }
  validateOptionalProvenance(value);
  if (value.semanticFacts !== undefined) {
    try {
      validateSemanticFactBundle(value.semanticFacts);
    } catch {
      // The semantic-fact plane is OPTIONAL (absent = unsupported). A malformed
      // or oversized decoded plane must degrade to unsupported, NOT brick the
      // required catalog for every graph read — the read views already treat an
      // absent plane cleanly. Drop it and note the swallow (P2 Phase 3).
      delete (value as { semanticFacts?: unknown }).semanticFacts;
      logger.debug({
        evt: 'graph.catalog_repo.semantic_facts_dropped',
        module: 'graph:catalog-repo',
        reason: 'validation-failed',
      });
    }
  }
}

/**
 * The exhaustive O(occurrences) container walk — every bucket, occurrence,
 * edge, and target bound-checked. Runs on first-load/untrusted reads; a
 * trusted warm re-read (lifted-column identity consistent with the payload)
 * skips it (plan 09 Task 6.1 — the read-side twin of the 293 MB report bug).
 *
 * @throws {Error} when a function container or its bounds are invalid.
 */
function validateFunctionContainers(value: CatalogRowPayload): void {
  const entries = Object.entries(value.functions);
  if (entries.length > MAX_FUNCTION_BUCKETS) throw new Error('Malformed catalog payload');
  let occurrenceCount = 0;
  const nestedCounts = { edges: 0, targets: 0 };
  for (const [name, bucket] of entries) {
    if (!isSafeCatalogText(name) || !Array.isArray(bucket)) {
      throw new Error('Malformed catalog function container');
    }
    occurrenceCount += bucket.length;
    if (
      occurrenceCount > MAX_OCCURRENCES ||
      !bucket.every((occurrence) => hasBoundedOccurrenceContainers(occurrence, nestedCounts))
    ) {
      throw new Error('Malformed catalog function container');
    }
  }
}

function isSafeCatalogText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CATALOG_TEXT &&
    !/\p{Cc}/u.test(value)
  );
}

function hasBoundedOccurrenceContainers(
  value: unknown,
  counts: { edges: number; targets: number },
): boolean {
  if (!isRecord(value)) return false;
  if (
    !Array.isArray(value.calls) ||
    value.calls.length > MAX_EDGES_PER_OCCURRENCE ||
    (value.dependencies !== undefined && !Array.isArray(value.dependencies)) ||
    (Array.isArray(value.dependencies) && value.dependencies.length > MAX_EDGES_PER_OCCURRENCE)
  ) {
    return false;
  }
  return (
    addBoundedEdges(value.calls, counts) &&
    (value.dependencies === undefined ||
      addBoundedEdges(value.dependencies as readonly unknown[], counts))
  );
}

const DEPENDENCY_TARGET_KINDS = new Set([
  'catalog-source',
  'declaration-file',
  'external',
  'unresolved',
]);
const DEPENDENCY_RESOLUTION_BASES = new Set([
  'catalog-target',
  'workspace-manifest',
  'external-specifier',
  'unresolved',
]);

/**
 * Validate a persisted {@link DependencyEdge} classification after JSON decode
 * (P2 Phase 0): closed-set form/role (a valid pair), closed-set targetKind/basis,
 * bounded reason text, and — when present — a bounded `resolvedPackage`. A
 * malformed/oversized classification on a TAMPERED catalog is rejected fail-closed
 * before projection, never silently loaded.
 */
function isSafeDependencyClassification(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { form, role, targetKind, basis, reason, resolvedPackage } = value;
  if (typeof form !== 'string' || typeof role !== 'string') return false;
  // `isValidDependencyFormRole` also constrains each axis to its closed set.
  if (!isValidDependencyFormRole(form as never, role as never)) return false;
  if (typeof targetKind !== 'string' || !DEPENDENCY_TARGET_KINDS.has(targetKind)) return false;
  if (typeof basis !== 'string' || !DEPENDENCY_RESOLUTION_BASES.has(basis)) return false;
  if (!isSafeCatalogText(reason)) return false;
  if (resolvedPackage !== undefined && !isSafeCatalogText(resolvedPackage)) return false;
  return true;
}

function addBoundedEdges(
  edges: readonly unknown[],
  counts: { edges: number; targets: number },
): boolean {
  counts.edges += edges.length;
  if (counts.edges > MAX_NESTED_EDGES) return false;
  for (const edge of edges) {
    if (!isRecord(edge) || !Array.isArray(edge.to)) continue;
    if (edge.to.length > MAX_TARGETS_PER_EDGE) return false;
    // Dependency edges carry an optional atomic classification; call edges never
    // do (`classification` is undefined and the check is skipped).
    if (edge.classification !== undefined && !isSafeDependencyClassification(edge.classification)) {
      return false;
    }
    counts.targets += edge.to.length;
    if (counts.targets > MAX_NESTED_TARGETS) return false;
  }
  return true;
}

interface ShardFragmentRowIdentity {
  readonly shardId: string;
  readonly language: string;
  readonly cacheKey: string;
  readonly shardFingerprint: string;
}

/** Fail-closed validator for one decoded shard-fragment cache payload. */
function validateShardBuildResult(
  value: unknown,
  row: ShardFragmentRowIdentity,
): asserts value is ShardBuildResult {
  if (
    !isRecord(value) ||
    value.shardId !== row.shardId ||
    value.fingerprint !== row.shardFingerprint
  ) {
    throw new Error('Malformed shard fragment identity');
  }
  validateCatalogShape(value.fragment);
  validateFunctionContainers(value.fragment);
  if (
    value.fragment.language !== row.language ||
    value.fragment.cacheKey !== row.cacheKey ||
    !isSafeBoundaryCalls(value.boundaryCalls) ||
    !isSafeParseErrors(value.parseErrors)
  ) {
    throw new Error('Malformed shard fragment payload');
  }
}

function isSafeBoundaryCalls(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_BOUNDARY_CALLS &&
    value.every((entry) => isSafeBoundaryCall(entry))
  );
}

function isSafeBoundaryCall(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isSafeCatalogText(value.ownerHash) &&
    isSafeCatalogText(value.ownerFile) &&
    isPositiveInteger(value.ownerLine) &&
    isNonNegativeInteger(value.ownerColumn) &&
    isSafeCatalogText(value.calleeName) &&
    isOptionalCatalogText(value.importedName) &&
    isOptionalCatalogText(value.importSpecifier) &&
    isOptionalCatalogText(value.targetFile) &&
    (value.importSpecifier !== undefined || value.targetFile !== undefined) &&
    isPositiveInteger(value.line) &&
    isNonNegativeInteger(value.column) &&
    isBoundedMessage(value.text, CALL_EDGE_TEXT_MAX) &&
    (value.discarded === undefined || typeof value.discarded === 'boolean')
  );
}

function isSafeParseErrors(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PARSE_ERRORS &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isSafeCatalogText(entry.filePath) &&
        isBoundedMessage(entry.message, MAX_CATALOG_TEXT),
    )
  );
}

function isOptionalCatalogText(value: unknown): boolean {
  return value === undefined || isSafeCatalogText(value);
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedMessage(value: unknown, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes('\0')
  );
}

/**
 * SQLite/Drizzle-backed repository for the graph catalog and its per-shard
 * fragments. Owns the `graph_catalog` row plus the `graph_shard_fragment`
 * table; all reads/writes are synchronous (better-sqlite3). The orchestrator
 * uses it to persist whole catalogs and incremental shard fragments, and to
 * fingerprint-match for cache validity without parsing the full payload.
 */
export class CatalogRepo {
  private readonly datastore: DrizzleDataStore;

  // @yagni-ignore-next-line duplicate-body-candidate -- repository constructors intentionally share the same datastore narrowing idiom; a base class would add indirection without reducing behavior.
  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleHandle(datastore);
  }

  /**
   * True when a full container walk already validated this lifted identity
   * for this datastore in this process. Content-keyed validation-fact cache
   * (idempotent, never run state); keyed by the datastore handle via WeakMap
   * so it cannot outlive the store.
   */
  private hasValidatedIdentity(identityKey: string): boolean {
    return VALIDATED_CATALOG_IDENTITIES.get(this.datastore)?.has(identityKey) === true;
  }

  private markValidatedIdentity(identityKey: string): void {
    let validated = VALIDATED_CATALOG_IDENTITIES.get(this.datastore);
    if (validated === undefined) {
      validated = new Set();
      VALIDATED_CATALOG_IDENTITIES.set(this.datastore, validated);
    }
    validated.add(identityKey);
    // Bounded: evict the oldest identity (insertion order) past the cap.
    if (validated.size > MAX_VALIDATED_IDENTITIES) {
      const oldest = validated.values().next().value;
      if (oldest !== undefined) validated.delete(oldest);
    }
  }

  /**
   * Read only lifted identity columns for the single catalog row (id = 1).
   * Never selects/parses payload. Returns null when no row exists.
   */
  readIdentity(): {
    language: string;
    cacheKey: string;
    filesFingerprint: string;
    builtAt: string;
  } | null {
    const row = this.datastore.db
      .select({
        language: graphCatalog.language,
        cacheKey: graphCatalog.cacheKey,
        filesFingerprint: graphCatalog.filesFingerprint,
        builtAt: graphCatalog.builtAt,
      })
      .from(graphCatalog)
      .where(sql`id = 1`)
      .limit(1)
      .get();
    if (!row) return null;
    return {
      language: row.language,
      cacheKey: row.cacheKey,
      filesFingerprint: row.filesFingerprint,
      builtAt: row.builtAt,
    };
  }

  /**
   * Replace the catalog with a fresh value. Mirrors v1's atomic
   * tmp-file + rename write — the upsert is a single statement, and
   * SQLite's transaction semantics guarantee no torn reads.
   */
  replaceAll(catalog: Catalog): void {
    this.datastore.withWriteLock('graph.catalog.replace', () => {
      try {
        const filesFingerprint = catalog.filesFingerprint ?? '';
        const payload: CatalogRowPayload = {
          version: catalog.version,
          tool: catalog.tool,
          language: catalog.language,
          builtAt: catalog.builtAt,
          cacheKey: catalog.cacheKey,
          filesFingerprint: catalog.filesFingerprint,
          resolutionMode: catalog.resolutionMode,
          adapterSelection: catalog.adapterSelection,
          engineMode: catalog.engineMode,
          shardCacheInputs: catalog.shardCacheInputs,
          buildCoverage: catalog.buildCoverage,
          functions: catalog.functions,
          // Carries through whatever the caller attached; `undefined` when none
          // (a lean run) so the key is omitted from the persisted JSON.
          reExports: catalog.reExports,
          semanticFacts: catalog.semanticFacts,
          features: catalog.features,
        };
        this.datastore.db
          .insert(graphCatalog)
          .values({
            id: 1,
            language: catalog.language,
            cacheKey: catalog.cacheKey,
            filesFingerprint,
            builtAt: catalog.builtAt,
            payload,
          })
          .onConflictDoUpdate({
            target: graphCatalog.id,
            set: {
              language: sql`excluded.language`,
              cacheKey: sql`excluded.cache_key`,
              filesFingerprint: sql`excluded.files_fingerprint`,
              builtAt: sql`excluded.built_at`,
              payload: sql`excluded.payload`,
            },
          })
          .run();
        logger.info({
          evt: 'graph.catalog.write.complete',
          module: MODULE_NAME,
          msg: 'Catalog written',
          functions: Object.keys(catalog.functions).length,
        });
      } catch (error) {
        /* v8 ignore start */
        // Call sites swallow this as best-effort cache behavior ("already
        // logged"), so this line is the ONLY record of a repeated cache-write
        // failure that silently forces full rebuilds — it must carry the cause.
        logger.error({
          evt: 'graph.catalog.write.error',
          module: MODULE_NAME,
          msg: 'Failed to write catalog',
          err: boundedErrorCause(error),
        });
        throw error;
        /* v8 ignore stop */
      }
    });
  }

  /**
   * Load the full catalog. Returns `null` on cache miss (no row).
   * Reconstructs the legacy `Catalog` shape from the JSON payload at
   * parity — view derivations under
   * `packages/contracts/src/persistence/dashboard/code-paths/` consume
   * the same shape they always have.
   */
  loadFullCatalog(): Catalog | null {
    try {
      const row = this.datastore.db
        .select()
        .from(graphCatalog)
        .where(sql`id = 1`)
        .get();
      if (!row) {
        logger.info({
          evt: 'graph.catalog.read.miss',
          module: MODULE_NAME,
          reason: 'empty-catalog',
        });
        return null;
      }
      const payload: unknown = row.payload;
      // The cheap gate (shape/version/provenance) ALWAYS runs — a corrupt or
      // wrong-generation row fails loud on every path.
      validateCatalogShape(payload);
      // Trusted warm re-read (plan 09 Task 6.1): the exhaustive
      // O(occurrences) container walk runs on the FIRST load of an identity
      // in this process (and after any identity/lifted-column drift), then is
      // memoized — repeat loads of the already-validated identity skip it.
      // Tampered rows stay fail-closed: a tamper lands on a not-yet-validated
      // read (fresh process) or changes the payload the walk validated, and
      // the memo key includes the lifted columns, so the P2 Phase 0
      // dependency-classification rejection contract is preserved.
      const identityConsistent =
        row.language === payload.language &&
        row.cacheKey === payload.cacheKey &&
        row.builtAt === payload.builtAt &&
        row.filesFingerprint === (payload.filesFingerprint ?? '');
      const identityKey = `${row.language}\n${row.cacheKey}\n${row.builtAt}\n${row.filesFingerprint}`;
      const trustedWarmRead = identityConsistent && this.hasValidatedIdentity(identityKey);
      if (!trustedWarmRead) {
        validateFunctionContainers(payload);
        if (identityConsistent) this.markValidatedIdentity(identityKey);
      }
      logger.debug({
        evt: 'graph.catalog.warmread.revalidate',
        module: MODULE_NAME,
        mode: trustedWarmRead ? 'skipped' : 'full',
      });
      logger.info({
        evt: 'graph.catalog.read.hit',
        module: MODULE_NAME,
        functions: Object.keys(payload.functions).length,
      });
      return {
        version: payload.version,
        tool: payload.tool,
        language: payload.language,
        builtAt: payload.builtAt,
        cacheKey: payload.cacheKey,
        filesFingerprint: payload.filesFingerprint,
        resolutionMode: payload.resolutionMode,
        adapterSelection: payload.adapterSelection,
        engineMode: payload.engineMode,
        shardCacheInputs: payload.shardCacheInputs,
        buildCoverage: payload.buildCoverage,
        functions: payload.functions,
        reExports: payload.reExports,
        semanticFacts: payload.semanticFacts,
        features: payload.features,
      };
    } catch (error) {
      /* v8 ignore start */
      // Read-side twin of the write-error cause (a cause-less line was the
      // only record of a cache serving stale data / forcing rebuilds).
      logger.error({
        evt: 'graph.catalog.read.error',
        module: MODULE_NAME,
        code: CATALOG_UNREADABLE.code,
        definition: CATALOG_UNREADABLE,
        metadata: { view: 'read-failed' },
        err: boundedErrorCause(error),
      });
      throw error;
      /* v8 ignore stop */
    }
  }

  /**
   * Read the catalog as the cross-tool {@link GraphCatalog} contract —
   * the shape the report renderer and graph contribution depend on.
   * This is the supported cross-tool read path: it lets fitness drop its
   * raw-SQL `SELECT … FROM graph_catalog` (audit 2026-05-29, H1). The
   * internal `Catalog` is structurally assignable to the GraphCatalog
   * contract, so this is a plain widening — no cast — verified by the
   * compiler at this boundary, where graph owns both types.
   */
  loadCatalogContract(): GraphCatalog | null {
    return this.loadFullCatalog();
  }

  /**
   * True iff a catalog row exists. Used by the orchestrator to short-
   * circuit fingerprint mismatch checks when nothing is cached.
   */
  hasAnyCatalog(): boolean {
    const row = this.datastore.db.select({ id: graphCatalog.id }).from(graphCatalog).limit(1).get();
    return row !== undefined;
  }

  // ── Per-shard fragment cache (plan #2 — sharded build) ──────────

  /**
   * Persist one shard's `ShardBuildResult`, replacing any prior row for
   * the same shard id. The validity keys (`cache_key`, `shard_fingerprint`)
   * are lifted from the result so a reuse check needs no payload parse.
   */
  upsertShardFragment(result: ShardBuildResult): void {
    this.datastore.withWriteLock('graph.shard_fragment.upsert', () => {
      this.datastore.db
        .insert(graphShardFragment)
        .values({
          shardId: result.shardId,
          language: result.fragment.language,
          cacheKey: result.fragment.cacheKey,
          shardFingerprint: result.fingerprint,
          payload: result,
        })
        .onConflictDoUpdate({
          target: graphShardFragment.shardId,
          set: {
            language: sql`excluded.language`,
            cacheKey: sql`excluded.cache_key`,
            shardFingerprint: sql`excluded.shard_fingerprint`,
            payload: sql`excluded.payload`,
          },
        })
        .run();
    });
  }

  /**
   * Load a shard fragment ONLY if it is still valid — both the shard's
   * cache key (tsconfig/version/mode) and its files fingerprint must match
   * the current run. Returns `null` on miss or staleness, signalling the
   * orchestrator to re-run that shard's worker. No parse happens here
   * beyond the JSON payload of a single valid shard.
   */
  loadValidShardFragment(
    shardId: string,
    expectedCacheKey: string,
    expectedFingerprint: string,
  ): ShardBuildResult | null {
    const row = this.datastore.db
      .select()
      .from(graphShardFragment)
      .where(sql`shard_id = ${shardId}`)
      .get();
    if (!row) return null;
    if (row.cacheKey !== expectedCacheKey || row.shardFingerprint !== expectedFingerprint) {
      return null;
    }
    const payload: unknown = row.payload;
    try {
      validateShardBuildResult(payload, row);
      return payload;
    } catch (error) {
      // @swallow-ok the shard cache is disposable: reject this row, report the
      // registered integrity condition, and let the planner rebuild the shard.
      logger.error({
        evt: 'graph.shard_fragment.read.error',
        module: MODULE_NAME,
        code: CATALOG_UNREADABLE.code,
        definition: CATALOG_UNREADABLE,
        metadata: { condition: 'shard-fragment-malformed', shard: shardId },
        err: boundedErrorCause(error),
      });
      return null;
    }
  }

  /**
   * Drop fragment rows for shards no longer present in the current build
   * (e.g. a package was removed). Keeps the per-shard cache from
   * accumulating stale rows. No-op when `keepShardIds` is empty.
   */
  pruneShardFragmentsExcept(keepShardIds: readonly string[]): void {
    if (keepShardIds.length === 0) return;
    this.datastore.withWriteLock('graph.shard_fragment.prune', () => {
      const separator = sql`, `;
      const placeholders = keepShardIds.map((id) => sql`${id}`);
      const keepList = sql.join(placeholders, separator);
      this.datastore.db
        .delete(graphShardFragment)
        .where(sql`shard_id NOT IN (${keepList})`)
        .run();
    });
  }
}
