/** Catalog generation sync and refresh controller (MCP Graph Audit Phase 1). */

import { ephemeralProjectCacheKey, err, ok, type Result } from '@opensip-cli/core';
import {
  type Catalog,
  type CatalogIdentity,
  type FreshnessVerification,
  type GraphAdapterRegistryReader,
} from '@opensip-cli/graph/read';

import { CatalogFreshnessController } from './catalog-freshness-controller.js';
import {
  createGeneration,
  type CatalogGeneration,
  type GenerationSource,
  type RefreshOutcome,
} from './catalog-generation-model.js';
import {
  catalogMatchesIdentity,
  mapCatalogIdentityError,
  safeCatalogGenerationKey,
} from './catalog-identity.js';
import { fromGraphReadError, readError, type McpReadError } from './mcp-error.js';

import type { DataStore } from '@opensip-cli/datastore';

export { FRESHNESS_BURST_MS } from './catalog-freshness-controller.js';
export {
  catalogGenerationKey,
  createGeneration,
  generationImpactIndex,
} from './catalog-generation-model.js';
export type {
  CatalogGeneration,
  GenerationSource,
  RefreshOutcome,
} from './catalog-generation-model.js';

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

interface RefreshControl {
  forceRequested: boolean;
  decision: 'pending' | 'rebuild' | 'no-op';
}

interface RefreshFlight {
  readonly control: RefreshControl;
  readonly promise: Promise<Result<RefreshOutcome, McpReadError>>;
}

/**
 * Concrete instance-owned generation state machine. No interface/factory.
 */
export class GraphGenerationController {
  private generation: CatalogGeneration | undefined;
  private loadError: McpReadError | undefined;
  private readonly freshness: CatalogFreshnessController;
  private inFlightRefresh: RefreshFlight | undefined;
  private syncing: Promise<Result<CatalogGeneration | undefined, McpReadError>> | undefined;

  constructor(private readonly deps: GenerationControllerDeps) {
    this.freshness = new CatalogFreshnessController({
      projectRoot: deps.projectRoot,
      adapters: deps.adapters,
      verify: deps.verify,
      isCurrentGeneration: (key) => this.generation?.key === key,
      log: deps.log,
    });
  }

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
    const flight = this.syncing ?? this.syncPersistedGeneration();
    this.syncing = flight;
    try {
      return await flight;
    } finally {
      if (this.syncing === flight) this.syncing = undefined;
    }
  }

  private syncPersistedGeneration(): Promise<Result<CatalogGeneration | undefined, McpReadError>> {
    const started = Date.now();
    const priorGeneration = this.generation;
    const priorLoadError = this.loadError;
    const priorFreshness = this.freshness.snapshot();
    const restore = (): void => {
      this.generation = priorGeneration;
      this.loadError = priorLoadError;
      this.freshness.restore(priorFreshness);
    };
    try {
      const hadPrior = this.generation !== undefined;
      const source: GenerationSource = hadPrior ? 'persisted-auto-swap' : 'initial-load';
      const first = this.probeAndMaybeLoad(source);
      if (!first.ok) {
        restore();
        return Promise.resolve(first);
      }
      // Writer race: re-probe once if identity flipped during load.
      const second = this.probeAndMaybeLoad(
        this.generation === undefined ? 'initial-load' : 'persisted-auto-swap',
      );
      if (!second.ok) {
        restore();
        return Promise.resolve(second);
      }
      // If still churning, keep prior generation and report error.
      const idNow = this.deps.readIdentity(this.deps.store);
      if (!idNow.ok) {
        const failure = mapCatalogIdentityError(idNow.error);
        restore();
        return Promise.resolve(err(failure));
      }
      const currentKey = idNow.value === null ? undefined : safeCatalogGenerationKey(idNow.value);
      if (currentKey !== undefined && !currentKey.ok) {
        restore();
        return Promise.resolve(currentKey);
      }
      const finalKey = currentKey?.value;
      if (finalKey !== this.generation?.key) {
        restore();
        return Promise.resolve(
          err(
            readError(
              'catalog-churn',
              'Persisted catalog identity changed repeatedly during load; prior generation retained.',
            ),
          ),
        );
      }
      this.logGenerationTransition(priorGeneration, this.generation, Date.now() - started);
      return Promise.resolve(ok(this.generation));
    } catch {
      restore();
      return Promise.resolve(
        err(readError('catalog-sync-failed', 'Failed to synchronize graph catalog generation.')),
      );
    }
  }

  private logGenerationTransition(
    prior: CatalogGeneration | undefined,
    next: CatalogGeneration | undefined,
    durationMs: number,
  ): void {
    if (prior?.key === next?.key) return;
    if (next === undefined) {
      if (prior !== undefined) {
        this.deps.log?.('mcp.graph.generation.removed', {
          priorAvailable: true,
          durationMs,
        });
      }
      return;
    }
    this.deps.log?.(
      prior === undefined ? 'mcp.graph.generation.loaded' : 'mcp.graph.generation.swapped',
      {
        source: next.source,
        mode: next.catalog.resolutionMode ?? 'exact',
        priorAvailable: prior !== undefined,
        durationMs,
      },
    );
  }

  private probeAndMaybeLoad(
    source: GenerationSource,
  ): Result<CatalogGeneration | undefined, McpReadError> {
    const identityResult = this.deps.readIdentity(this.deps.store);
    if (!identityResult.ok) {
      this.loadError = mapCatalogIdentityError(identityResult.error);
      return err(this.loadError);
    }
    const identity = identityResult.value;
    if (identity === null) {
      this.generation = undefined;
      this.loadError = undefined;
      this.invalidateFreshness();
      return ok(undefined);
    }
    const validatedKey = safeCatalogGenerationKey(identity);
    if (!validatedKey.ok) {
      this.loadError = validatedKey.error;
      return validatedKey;
    }
    const key = validatedKey.value;
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
      this.freshness.invalidate();
      return ok(undefined);
    }
    // Confirm lifted identity still matches after full load.
    const confirm = this.deps.readIdentity(this.deps.store);
    if (!confirm.ok) {
      this.loadError = mapCatalogIdentityError(confirm.error);
      return err(this.loadError);
    }
    const confirmedIdentity = confirm.value;
    if (confirmedIdentity === null) return ok(this.generation);
    const confirmedKey = safeCatalogGenerationKey(confirmedIdentity);
    if (!confirmedKey.ok) {
      this.loadError = confirmedKey.error;
      return confirmedKey;
    }
    if (confirmedKey.value !== key) {
      // Race — caller may retry once.
      return ok(this.generation);
    }
    if (!catalogMatchesIdentity(loaded.value, confirmedIdentity)) {
      this.loadError = readError(
        'catalog-identity-mismatch',
        'Persisted graph catalog payload does not match its lifted identity.',
      );
      return err(this.loadError);
    }
    const next = createGeneration(loaded.value, source, confirmedIdentity);
    this.generation = next;
    this.loadError = undefined;
    this.freshness.invalidate();
    return ok(next);
  }

  /** Coalesced freshness verification with 2s burst reuse. */
  async verifyCurrent(
    gen: CatalogGeneration,
  ): Promise<Result<FreshnessVerification, McpReadError>> {
    return await this.freshness.verify(gen);
  }

  invalidateFreshness(): void {
    this.freshness.invalidate();
  }

  /**
   * Explicit refresh: sync → verify → optional rebuild.
   * Single-flight; keeps prior generation on failure.
   */
  async refresh(forceRebuild = false): Promise<Result<RefreshOutcome, McpReadError>> {
    const active = this.inFlightRefresh;
    if (active !== undefined) {
      if (!forceRebuild || active.control.decision === 'rebuild') return await active.promise;
      if (active.control.decision === 'pending') {
        active.control.forceRequested = true;
        return await active.promise;
      }
      await active.promise;
      if (this.inFlightRefresh === active) this.inFlightRefresh = undefined;
      return await this.refresh(true);
    }
    const control: RefreshControl = { forceRequested: forceRebuild, decision: 'pending' };
    const flight: RefreshFlight = { control, promise: this.runRefresh(control) };
    this.inFlightRefresh = flight;
    try {
      return await flight.promise;
    } finally {
      if (this.inFlightRefresh === flight) this.inFlightRefresh = undefined;
    }
  }

  private async runRefresh(control: RefreshControl): Promise<Result<RefreshOutcome, McpReadError>> {
    const started = Date.now();
    const priorGeneration = this.generation;
    const priorAvailable = priorGeneration !== undefined;
    const priorKey = priorGeneration?.key;
    let failureFallback = priorGeneration;
    let failedPhase = 'sync';
    this.invalidateFreshness();
    try {
      const captured = await this.capture();
      if (!captured.ok) {
        return err(this.refreshFailure(captured.error, failedPhase, started, failureFallback));
      }
      const gen = captured.value;
      failureFallback = gen ?? failureFallback;
      failedPhase = 'verify';
      const reusable = await this.reuseFreshGeneration({
        control,
        gen,
        priorKey,
        started,
        priorAvailable,
      });
      if (!reusable.ok) {
        this.generation = failureFallback;
        return err(this.refreshFailure(reusable.error, failedPhase, started, failureFallback));
      }
      if (reusable.value !== undefined) return ok(reusable.value);
      control.decision = 'rebuild';
      failedPhase = 'rebuild';
      const rebuilt = await this.deps.rebuild();
      if (!rebuilt.ok) {
        this.generation = failureFallback;
        return err(this.refreshFailure(rebuilt.error, failedPhase, started, failureFallback));
      }
      const next = createGeneration(rebuilt.value, 'refresh-rebuild');
      const hadGeneration = this.generation !== undefined;
      this.generation = next;
      this.loadError = undefined;
      this.invalidateFreshness();
      this.deps.log?.(
        hadGeneration ? 'mcp.graph.generation.swapped' : 'mcp.graph.generation.loaded',
        {
          source: 'refresh-rebuild',
          mode: next.catalog.resolutionMode ?? 'exact',
          priorAvailable: hadGeneration,
          durationMs: Date.now() - started,
        },
      );
      return ok({
        action: 'rebuilt',
        generation: next,
        durationMs: Date.now() - started,
        priorGenerationAvailable: priorAvailable,
      });
    } catch {
      this.generation = failureFallback;
      return err(this.refreshFailure(undefined, failedPhase, started, failureFallback));
    }
  }

  private async reuseFreshGeneration(input: {
    readonly control: RefreshControl;
    readonly gen: CatalogGeneration | undefined;
    readonly priorKey: string | undefined;
    readonly started: number;
    readonly priorAvailable: boolean;
  }): Promise<Result<RefreshOutcome | undefined, McpReadError>> {
    if (input.gen === undefined || input.control.forceRequested) return ok(undefined);
    const verified = await this.verifyCurrent(input.gen);
    if (!verified.ok) return verified;
    const reusable = verified.value.fresh && verified.value.verification === 'complete';
    if (!reusable || input.control.forceRequested) {
      if (input.control.forceRequested) input.control.decision = 'rebuild';
      return ok(undefined);
    }
    input.control.decision = 'no-op';
    return ok({
      action: input.priorKey === input.gen.key ? 'no-op' : 'reloaded',
      generation: input.gen,
      durationMs: Date.now() - input.started,
      priorGenerationAvailable: input.priorAvailable,
    });
  }

  private refreshFailure(
    cause: McpReadError | undefined,
    failedPhase: string,
    started: number,
    retainedGeneration: CatalogGeneration | undefined,
  ): McpReadError {
    return readError(
      'graph-refresh-failed',
      'Graph refresh failed due to an infrastructure error.',
      {
        failedPhase,
        outcome: 'failed',
        durationMs: Date.now() - started,
        priorGenerationAvailable: retainedGeneration !== undefined,
        projectKey: ephemeralProjectCacheKey(this.deps.projectRoot),
        priorGenerationKey: retainedGeneration?.key ?? 'missing',
        currentGenerationKey: this.generation?.key ?? 'missing',
        ...(cause?.code === undefined ? {} : { causeCode: cause.code }),
      },
    );
  }
}

function mapLoadError(error: { code: string; message: string }): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-generation',
    message: error.message,
  });
}
