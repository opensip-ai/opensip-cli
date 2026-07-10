/**
 * Catalog generation identity + lifecycle controller (MCP Graph Audit Phase 1).
 *
 * `catalogGenerationKey` is the sole public generation identity (`g1:…`).
 * `GraphGenerationController` owns metadata sync, atomic swap, verification
 * coalescing, per-generation caches, and refresh single-flight.
 */

import { createHash } from 'node:crypto';

import { err, ok, type Result } from '@opensip-cli/core';
import {
  buildGraphReadIndexes,
  type Catalog,
  type CatalogIdentity,
  type FreshnessVerification,
  type Indexes,
  type GraphAdapterRegistryReader,
} from '@opensip-cli/graph/read';

import { fromGraphReadError, readError, type McpReadError } from './mcp-error.js';

import type { DataStore } from '@opensip-cli/datastore';

/** Burst window for reusing a completed freshness verdict (ms). */
export const FRESHNESS_BURST_MS = 2000;

export type GenerationSource = 'initial-load' | 'persisted-auto-swap' | 'refresh-rebuild';

/**
 * Canonical generation key: `g1:` + sha256 of the fixed versioned identity tuple.
 * Package-internal — not re-exported from the MCP package barrel.
 */
export function catalogGenerationKey(identity: CatalogIdentity): string {
  const payload = JSON.stringify([
    'opensip:mcp:catalog-generation',
    1,
    identity.language,
    identity.cacheKey,
    identity.filesFingerprint,
    identity.builtAt,
  ]);
  return `g1:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/** One immutable in-memory snapshot of the served catalog + derived indexes. */
export interface CatalogGeneration {
  readonly key: string;
  readonly identity: CatalogIdentity;
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly builtAt: string;
  readonly loadedAt: string;
  readonly source: GenerationSource;
}

export function createGeneration(
  catalog: Catalog,
  source: GenerationSource,
  identity?: CatalogIdentity,
): CatalogGeneration {
  const id: CatalogIdentity = identity ?? {
    language: catalog.language,
    cacheKey: catalog.cacheKey,
    filesFingerprint: catalog.filesFingerprint ?? '',
    builtAt: catalog.builtAt,
  };
  return {
    key: catalogGenerationKey(id),
    identity: id,
    catalog,
    indexes: buildGraphReadIndexes(catalog),
    builtAt: catalog.builtAt,
    loadedAt: new Date().toISOString(),
    source,
  };
}

export interface GenerationControllerDeps {
  readonly store: DataStore;
  readonly projectRoot: string;
  readonly adapters: GraphAdapterRegistryReader;
  readonly readIdentity: (
    store: DataStore,
  ) => Result<CatalogIdentity | null, { code: string; message: string; operation?: string }>;
  readonly loadCatalog: (
    store: DataStore,
  ) => Result<Catalog | null, { code: string; message: string; operation?: string }>;
  readonly verify: (input: {
    projectRoot: string;
    catalog: Catalog;
    adapters: GraphAdapterRegistryReader;
  }) => Promise<
    Result<FreshnessVerification, { code: string; message: string; operation?: string }>
  >;
  readonly rebuild: () => Promise<Result<Catalog, McpReadError>>;
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

/**
 * Concrete instance-owned generation state machine. No interface/factory.
 */
export class GraphGenerationController {
  private generation: CatalogGeneration | undefined;
  private loadError: McpReadError | undefined;
  private freshnessCache:
    | {
        readonly key: string;
        readonly verifiedAtMs: number;
        readonly verdict: FreshnessVerification;
      }
    | undefined;
  private inFlightVerify: Promise<Result<FreshnessVerification, McpReadError>> | undefined;
  private inFlightRefresh: Promise<Result<RefreshOutcome, McpReadError>> | undefined;
  private syncing: Promise<Result<CatalogGeneration | undefined, McpReadError>> | undefined;

  constructor(private readonly deps: GenerationControllerDeps) {}

  /** Currently loaded generation (may be stale vs disk — call capture first). */
  peek(): CatalogGeneration | undefined {
    return this.generation;
  }

  lastLoadError(): McpReadError | undefined {
    return this.loadError;
  }

  /**
   * O(1) identity probe + optional full load/swap. Captures one immutable
   * generation for the calling query.
   */
  async capture(): Promise<Result<CatalogGeneration | undefined, McpReadError>> {
    this.syncing ??= this.syncPersistedGeneration();
    try {
      return await this.syncing;
    } finally {
      this.syncing = undefined;
    }
  }

  private syncPersistedGeneration(): Promise<Result<CatalogGeneration | undefined, McpReadError>> {
    const started = Date.now();
    try {
      const hadPrior = this.generation !== undefined;
      const source: GenerationSource = hadPrior ? 'persisted-auto-swap' : 'initial-load';
      const first = this.probeAndMaybeLoad(source);
      if (!first.ok) return Promise.resolve(first);
      // Writer race: re-probe once if identity flipped during load.
      const second = this.probeAndMaybeLoad(
        this.generation === undefined ? 'initial-load' : 'persisted-auto-swap',
      );
      if (!second.ok) return Promise.resolve(second);
      // If still churning, keep prior generation and report error.
      const idNow = this.deps.readIdentity(this.deps.store);
      if (!idNow.ok) {
        this.loadError = mapIdentityError(idNow.error);
        return Promise.resolve(err(this.loadError));
      }
      if (
        idNow.value !== null &&
        this.generation?.key !== undefined &&
        catalogGenerationKey(idNow.value) !== this.generation.key
      ) {
        this.deps.log?.('mcp.graph.generation.churn', {
          durationMs: Date.now() - started,
          outcome: 'failed',
        });
        return Promise.resolve(
          err(
            readError(
              'catalog-churn',
              'Persisted catalog identity changed repeatedly during load; prior generation retained.',
            ),
          ),
        );
      }
      return Promise.resolve(ok(this.generation));
    } catch {
      return Promise.resolve(
        err(readError('catalog-sync-failed', 'Failed to synchronize graph catalog generation.')),
      );
    }
  }

  private probeAndMaybeLoad(
    source: GenerationSource,
  ): Result<CatalogGeneration | undefined, McpReadError> {
    const identityResult = this.deps.readIdentity(this.deps.store);
    if (!identityResult.ok) {
      this.loadError = mapIdentityError(identityResult.error);
      return err(this.loadError);
    }
    const identity = identityResult.value;
    if (identity === null) {
      if (this.generation !== undefined) {
        this.deps.log?.('mcp.graph.generation.removed', {
          priorAvailable: true,
        });
      }
      this.generation = undefined;
      this.loadError = undefined;
      this.freshnessCache = undefined;
      return ok(undefined);
    }
    const key = catalogGenerationKey(identity);
    if (this.generation?.key === key) {
      return ok(this.generation);
    }
    const loaded = this.deps.loadCatalog(this.deps.store);
    if (!loaded.ok) {
      this.loadError = mapLoadError(loaded.error);
      return err(this.loadError);
    }
    if (loaded.value === null) {
      this.generation = undefined;
      this.loadError = undefined;
      this.freshnessCache = undefined;
      return ok(undefined);
    }
    // Confirm lifted identity still matches after full load.
    const confirm = this.deps.readIdentity(this.deps.store);
    if (!confirm.ok) {
      this.loadError = mapIdentityError(confirm.error);
      return err(this.loadError);
    }
    if (confirm.value === null || catalogGenerationKey(confirm.value) !== key) {
      // Race — caller may retry once.
      return ok(this.generation);
    }
    const prior = this.generation !== undefined;
    const next = createGeneration(loaded.value, source, confirm.value);
    this.generation = next;
    this.loadError = undefined;
    this.freshnessCache = undefined;
    this.deps.log?.(prior ? 'mcp.graph.generation.swapped' : 'mcp.graph.generation.loaded', {
      source,
      mode: next.catalog.resolutionMode ?? 'exact',
      priorAvailable: prior,
    });
    return ok(next);
  }

  /** Coalesced freshness verification with 2s burst reuse. */
  async verifyCurrent(
    gen: CatalogGeneration,
  ): Promise<Result<FreshnessVerification, McpReadError>> {
    const now = Date.now();
    if (
      this.freshnessCache?.key === gen.key &&
      now - this.freshnessCache.verifiedAtMs < FRESHNESS_BURST_MS
    ) {
      return ok(this.freshnessCache.verdict);
    }
    this.inFlightVerify ??= this.runVerify(gen);
    try {
      return await this.inFlightVerify;
    } finally {
      this.inFlightVerify = undefined;
    }
  }

  private async runVerify(
    gen: CatalogGeneration,
  ): Promise<Result<FreshnessVerification, McpReadError>> {
    const started = Date.now();
    const result = await this.deps.verify({
      projectRoot: this.deps.projectRoot,
      catalog: gen.catalog,
      adapters: this.deps.adapters,
    });
    if (!result.ok) {
      this.deps.log?.('mcp.graph.freshness.failed', {
        durationMs: Date.now() - started,
        outcome: 'failed',
      });
      return err(mapLoadError(result.error));
    }
    const verdict = result.value;
    this.freshnessCache = {
      key: gen.key,
      verifiedAtMs: Date.now(),
      verdict,
    };
    let evt = 'mcp.graph.freshness.failed';
    if (verdict.verification === 'complete') evt = 'mcp.graph.freshness.complete';
    else if (verdict.verification === 'partial') evt = 'mcp.graph.freshness.partial';
    this.deps.log?.(evt, {
      reasonCode: verdict.reasonCode,
      durationMs: Date.now() - started,
      fresh: verdict.fresh,
    });
    return ok(verdict);
  }

  invalidateFreshness(): void {
    this.freshnessCache = undefined;
  }

  /**
   * Explicit refresh: sync → verify → optional rebuild.
   * Single-flight; keeps prior generation on failure.
   */
  async refresh(forceRebuild = false): Promise<Result<RefreshOutcome, McpReadError>> {
    this.inFlightRefresh ??= this.runRefresh(forceRebuild);
    try {
      return await this.inFlightRefresh;
    } finally {
      this.inFlightRefresh = undefined;
    }
  }

  private async runRefresh(forceRebuild: boolean): Promise<Result<RefreshOutcome, McpReadError>> {
    const started = Date.now();
    const priorAvailable = this.generation !== undefined;
    try {
      const captured = await this.capture();
      if (!captured.ok) {
        return err(captured.error);
      }
      const gen = captured.value;
      if (gen !== undefined && !forceRebuild) {
        const verified = await this.verifyCurrent(gen);
        if (verified.ok && verified.value.fresh && verified.value.verification === 'complete') {
          const action = gen.source === 'persisted-auto-swap' ? 'reloaded' : 'no-op';
          return ok({
            action,
            generation: gen,
            durationMs: Date.now() - started,
            priorGenerationAvailable: priorAvailable,
          });
        }
      }
      const rebuilt = await this.deps.rebuild();
      if (!rebuilt.ok) {
        return err(rebuilt.error);
      }
      const next = createGeneration(rebuilt.value, 'refresh-rebuild');
      this.generation = next;
      this.loadError = undefined;
      this.freshnessCache = undefined;
      return ok({
        action: 'rebuilt',
        generation: next,
        durationMs: Date.now() - started,
        priorGenerationAvailable: priorAvailable,
      });
    } catch {
      return err(
        readError('graph-refresh-failed', 'Graph refresh failed due to an infrastructure error.', {
          priorGenerationAvailable: priorAvailable,
          durationMs: Date.now() - started,
        }),
      );
    }
  }
}

export interface RefreshOutcome {
  readonly action: 'no-op' | 'reloaded' | 'rebuilt';
  readonly generation: CatalogGeneration;
  readonly durationMs: number;
  readonly priorGenerationAvailable: boolean;
}

function mapIdentityError(error: { code: string; message: string }): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-identity',
    message: error.message,
  });
}

function mapLoadError(error: { code: string; message: string }): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-generation',
    message: error.message,
  });
}
