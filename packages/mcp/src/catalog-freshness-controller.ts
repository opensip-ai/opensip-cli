/** Per-generation freshness verification, coalescing, caching, and events. */

import { err, ok, type Result } from '@opensip-cli/core';
import { graphErrorCatalog } from '@opensip-cli/graph';

import { fromGraphReadError, type McpReadError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation-model.js';
import type {
  Catalog,
  FreshnessVerification,
  GraphAdapterRegistryReader,
} from '@opensip-cli/graph/read';

// Plan 01: the `GRAPH` head was mapped by nothing, so every one of these resolved to
// UNKNOWN_FAILURE — fatal and operator-only — for conditions MCP consumers branch on.
const CATALOG_UNREADABLE = graphErrorCatalog.require('GRAPH.CATALOG.UNREADABLE');

export const FRESHNESS_BURST_MS = 2000;

export interface CatalogFreshnessDeps {
  readonly projectRoot: string;
  readonly adapters: GraphAdapterRegistryReader;
  readonly verify: (input: {
    projectRoot: string;
    catalog: Catalog;
    adapters: GraphAdapterRegistryReader;
  }) => Promise<
    Result<FreshnessVerification, { code: string; message: string; operation?: string }>
  >;
  readonly isCurrentGeneration: (key: string) => boolean;
  readonly log?: (
    evt: string,
    fields: Record<string, string | number | boolean | undefined>,
  ) => void;
}

export interface FreshnessSnapshot {
  readonly key: string;
  readonly verifiedAtMs: number;
  readonly verdict: FreshnessVerification;
}

export interface CatalogFreshnessVerifyOptions {
  /** Bypass a completed verdict cached for an ordinary read burst. */
  readonly forceFresh?: boolean;
}

export class CatalogFreshnessController {
  private cache: FreshnessSnapshot | undefined;
  private readonly inFlight = new Map<
    string,
    Promise<Result<FreshnessVerification, McpReadError>>
  >();

  constructor(private readonly deps: CatalogFreshnessDeps) {}

  snapshot(): FreshnessSnapshot | undefined {
    return this.cache;
  }

  restore(snapshot: FreshnessSnapshot | undefined): void {
    this.cache = snapshot;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async verify(
    gen: CatalogGeneration,
    options?: CatalogFreshnessVerifyOptions,
  ): Promise<Result<FreshnessVerification, McpReadError>> {
    const now = Date.now();
    const cache = this.cache;
    if (options?.forceFresh !== true && cache?.key === gen.key) {
      const cacheAgeMs = now - cache.verifiedAtMs;
      if (cacheAgeMs >= 0 && cacheAgeMs < FRESHNESS_BURST_MS) {
        return ok(cache.verdict);
      }
    }
    const active = this.inFlight.get(gen.key);
    if (active !== undefined) return await active;
    const flight = this.runVerify(gen);
    this.inFlight.set(gen.key, flight);
    try {
      return await flight;
    } finally {
      if (this.inFlight.get(gen.key) === flight) this.inFlight.delete(gen.key);
    }
  }

  private async runVerify(
    gen: CatalogGeneration,
  ): Promise<Result<FreshnessVerification, McpReadError>> {
    const started = Date.now();
    let result: Awaited<ReturnType<CatalogFreshnessDeps['verify']>>;
    try {
      result = await this.deps.verify({
        projectRoot: this.deps.projectRoot,
        catalog: gen.catalog,
        adapters: this.deps.adapters,
      });
    } catch {
      result = err({
        code: CATALOG_UNREADABLE.code,
        definition: CATALOG_UNREADABLE,
        metadata: { view: 'verify-failed' },
        message: 'Catalog verification failed due to an infrastructure error',
      });
    }
    if (!result.ok) {
      this.deps.log?.('mcp.graph.freshness.failed', {
        reasonCode: result.error.code,
        verification: 'failed',
        resolutionMode: gen.catalog.resolutionMode ?? 'exact',
        engineMode: gen.catalog.engineMode ?? 'unknown',
        durationMs: Date.now() - started,
        outcome: 'failed',
      });
      return err(mapVerifyError(result.error));
    }
    const verdict = result.value;
    if (this.deps.isCurrentGeneration(gen.key)) {
      this.cache = { key: gen.key, verifiedAtMs: Date.now(), verdict };
    }
    this.logVerdict(gen, verdict, Date.now() - started);
    return ok(verdict);
  }

  private logVerdict(
    gen: CatalogGeneration,
    verdict: FreshnessVerification,
    durationMs: number,
  ): void {
    let event = 'mcp.graph.freshness.failed';
    if (verdict.verification === 'complete') event = 'mcp.graph.freshness.complete';
    else if (verdict.verification === 'partial') event = 'mcp.graph.freshness.partial';
    this.deps.log?.(event, {
      reasonCode: verdict.reasonCode,
      verification: verdict.verification,
      resolutionMode: gen.catalog.resolutionMode ?? 'exact',
      engineMode: gen.catalog.engineMode ?? 'unknown',
      added: verdict.changes?.added,
      modified: verdict.changes?.modified,
      deleted: verdict.changes?.deleted,
      durationMs,
      fresh: verdict.fresh,
    });
  }
}

function mapVerifyError(error: { code: string; message: string }): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-generation',
    message: error.message,
  });
}
