/** Instance-owned `@opensip-cli/codebase` adapter for one served project. */

import { resolve } from 'node:path';

import {
  buildProjectInventory,
  type LanguageEvidenceSupport,
  type ProjectInventory,
} from '@opensip-cli/codebase';
import { err, ok, type Result, type TargetResolver } from '@opensip-cli/core';

import { readError, type McpReadError } from './mcp-error.js';

import type {
  CodebaseFreshness,
  CodebaseInventoryStatus,
  CodebaseReadPort,
  FileContextDto,
  InventoryStatusOptions,
} from './codebase-read-port.js';
import type { PackageFact } from '@opensip-cli/contracts';

export interface LocalCodebaseReadPortDeps {
  readonly projectRoot: string;
  readonly configIdentity: string;
  /** Base scope seam; inventory feature-detects bounded expansion and fails closed if absent. */
  readonly targets?: TargetResolver;
  readonly languageEvidenceSupport?: LanguageEvidenceSupport;
  readonly log?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => void;
}

interface InventoryCache {
  readonly inventory: ProjectInventory;
  readonly capturedAt: string;
  readonly verifiedAtMs: number;
}

interface InventoryRefresh {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<Result<InventoryCache, McpReadError>>;
  waiters: number;
  settled: boolean;
}

/** Coalesce the normal status -> file -> selection read burst without going stale indefinitely. */
const INVENTORY_BURST_REUSE_MS = 2000;

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledResult<T>(): Result<T, McpReadError> {
  return err(readError('cancelled', 'Codebase inventory read was cancelled.'));
}

function reusableDuringBurst(cache: InventoryCache, nowMs: number): boolean {
  const ageMs = nowMs - cache.verifiedAtMs;
  return ageMs >= 0 && ageMs < INVENTORY_BURST_REUSE_MS;
}

function safeProjectFile(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.length > 1024 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    /\p{Cc}/u.test(normalized) ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function freshnessFor(cache: InventoryCache): CodebaseFreshness {
  const coverage = cache.inventory.snapshot.coverage;
  let verification: CodebaseFreshness['verification'] = 'missing';
  if (coverage.status === 'complete') verification = 'complete';
  else if (coverage.status === 'partial') verification = 'partial';
  return {
    fresh: coverage.status === 'complete',
    capturedAt: cache.capturedAt,
    verification,
    reasonCodes: coverage.reasonCodes,
  };
}

function inventoryNextActions(status: CodebaseFreshness): readonly string[] {
  if (status.verification === 'complete') return [];
  return ['Review configured targets and inventory coverage before relying on a negative answer.'];
}

function owningPackage(path: string, packages: readonly PackageFact[]): PackageFact | undefined {
  let owner: PackageFact | undefined;
  let ownerLength = -1;
  for (const candidate of packages) {
    const matches =
      candidate.root === '.' || path === candidate.root || path.startsWith(`${candidate.root}/`);
    if (matches && candidate.root.length > ownerLength) {
      owner = candidate;
      ownerLength = candidate.root.length;
    }
  }
  return owner;
}

/**
 * Concrete captured adapter. The cache belongs to this instance and is only
 * published after a non-aborted build; qualified partial/unavailable snapshots
 * remain observable rather than being rewritten as empty success.
 */
export class LocalCodebaseReadPort implements CodebaseReadPort {
  private readonly projectRoot: string;
  private readonly configIdentity: string;
  private readonly targets: TargetResolver | undefined;
  private readonly languageEvidenceSupport: LanguageEvidenceSupport | undefined;
  private readonly log: LocalCodebaseReadPortDeps['log'];
  private cache: InventoryCache | undefined;
  private inFlight: InventoryRefresh | undefined;
  private refreshGeneration = 0;

  constructor(deps: LocalCodebaseReadPortDeps) {
    // Preserve the configured lexical root for target resolution and stable
    // file identities. The inventory builder owns realpath containment checks.
    this.projectRoot = resolve(deps.projectRoot);
    this.configIdentity = deps.configIdentity;
    this.targets = deps.targets;
    this.languageEvidenceSupport = deps.languageEvidenceSupport;
    this.log = deps.log;
  }

  async inventoryStatus(
    signal?: AbortSignal,
    options?: InventoryStatusOptions,
  ): Promise<Result<CodebaseInventoryStatus, McpReadError>> {
    if (aborted(signal)) return cancelledResult();
    if (
      options?.forceFresh !== true &&
      this.cache !== undefined &&
      reusableDuringBurst(this.cache, Date.now())
    ) {
      return ok(this.projectStatus(this.cache));
    }
    const result = await this.waitForRefresh(this.getOrStartRefresh(), signal);
    return result.ok ? ok(this.projectStatus(result.value)) : result;
  }

  private getOrStartRefresh(): InventoryRefresh {
    if (this.inFlight !== undefined) return this.inFlight;
    const generation = ++this.refreshGeneration;
    const controller = new AbortController();
    const refresh: InventoryRefresh = {
      generation,
      controller,
      promise: this.refreshInventory(generation, controller.signal),
      waiters: 0,
      settled: false,
    };
    this.inFlight = refresh;
    void refresh.promise.then(() => {
      refresh.settled = true;
      if (this.inFlight === refresh) this.inFlight = undefined;
    });
    return refresh;
  }

  private waitForRefresh(
    refresh: InventoryRefresh,
    signal: AbortSignal | undefined,
  ): Promise<Result<InventoryCache, McpReadError>> {
    refresh.waiters += 1;
    if (signal?.aborted === true) {
      this.releaseRefreshWaiter(refresh, true);
      return Promise.resolve(cancelledResult());
    }
    return new Promise((resolveWaiter) => {
      let waiterSettled = false;
      const settle = (
        result: Result<InventoryCache, McpReadError>,
        waiterCancelled: boolean,
      ): void => {
        if (waiterSettled) return;
        waiterSettled = true;
        signal?.removeEventListener('abort', onAbort);
        this.releaseRefreshWaiter(refresh, waiterCancelled);
        resolveWaiter(result);
      };
      const onAbort = (): void => settle(cancelledResult(), true);
      signal?.addEventListener('abort', onAbort, { once: true });
      void refresh.promise.then((result) =>
        settle(signal?.aborted === true ? cancelledResult() : result, signal?.aborted === true),
      );
    });
  }

  private releaseRefreshWaiter(refresh: InventoryRefresh, waiterCancelled: boolean): void {
    refresh.waiters = Math.max(0, refresh.waiters - 1);
    if (!waiterCancelled || refresh.waiters > 0 || refresh.settled) return;
    refresh.controller.abort();
    if (this.inFlight === refresh) this.inFlight = undefined;
    if (this.refreshGeneration === refresh.generation) this.refreshGeneration += 1;
  }

  private async refreshInventory(
    generation: number,
    signal: AbortSignal,
  ): Promise<Result<InventoryCache, McpReadError>> {
    const started = Date.now();
    try {
      const inventory = await buildProjectInventory({
        projectRoot: this.projectRoot,
        configIdentity: this.configIdentity,
        ...(this.targets === undefined ? {} : { targets: this.targets }),
        ...(this.languageEvidenceSupport === undefined
          ? {}
          : { languageEvidenceSupport: this.languageEvidenceSupport }),
        signal,
      });
      const completedAtMs = Date.now();
      if (signal.aborted) {
        this.log?.('mcp.codebase.inventory.failed', {
          status: 'cancelled',
          durationMs: Math.max(0, completedAtMs - started),
        });
        return cancelledResult();
      }
      const cached = this.cache;
      const next: InventoryCache = {
        inventory:
          cached?.inventory.snapshot.snapshotId === inventory.snapshot.snapshotId
            ? cached.inventory
            : inventory,
        capturedAt: new Date(completedAtMs).toISOString(),
        verifiedAtMs: completedAtMs,
      };
      // A refresh result may only move the cache forward. Singleflight normally
      // serializes generations; the guard also protects future forced-refresh seams.
      if (generation === this.refreshGeneration) this.cache = next;
      this.log?.('mcp.codebase.inventory.completed', {
        status: inventory.snapshot.coverage.status,
        packageCount: inventory.snapshot.packages.length,
        fileCount: inventory.snapshot.files.length,
        durationMs: Math.max(0, completedAtMs - started),
        changed:
          cached !== undefined &&
          cached.inventory.snapshot.snapshotId !== inventory.snapshot.snapshotId,
        capReason: inventory.snapshot.coverage.reasonCodes.find(
          (reason) => reason.includes('-cap-') || reason.endsWith('-cap'),
        ),
      });
      return ok(generation === this.refreshGeneration ? next : (this.cache ?? next));
    } catch {
      const completedAtMs = Date.now();
      this.log?.('mcp.codebase.inventory.failed', {
        status: signal.aborted ? 'cancelled' : 'failed',
        durationMs: Math.max(0, completedAtMs - started),
      });
      return signal.aborted
        ? cancelledResult()
        : err(readError('inventory-read-failed', 'Project inventory could not be read.'));
    }
  }

  async fileContext(
    file: string,
    signal?: AbortSignal,
  ): Promise<Result<FileContextDto, McpReadError>> {
    const normalized = safeProjectFile(file);
    if (normalized === undefined) {
      return err(readError('invalid-input', 'File must be a project-relative path.'));
    }
    const status = await this.inventoryStatus(signal);
    if (!status.ok) return status;
    if (aborted(signal)) {
      return err(readError('cancelled', 'File context read was cancelled.'));
    }
    // Keep the lookup on the exact snapshot returned by this call. Reading the
    // mutable instance cache again could mix identities if concurrent requests
    // refresh it between the status read and this projection.
    const snapshot = status.value.snapshot;
    const fact = snapshot.files.find((candidate) => candidate.path === normalized);
    if (fact !== undefined) {
      let packageFact = owningPackage(normalized, snapshot.packages);
      if (fact.packageName !== undefined) {
        packageFact =
          snapshot.packages.find((item) => item.name === fact.packageName) ?? packageFact;
      }
      return ok({
        status: 'found',
        file: fact,
        ...(packageFact === undefined ? {} : { package: packageFact }),
        inventoryIdentity: status.value.identity,
        project: snapshot.project,
        coverage: status.value.coverage,
        freshness: status.value.freshness,
        reasonCodes: [],
        nextActions: [],
      });
    }
    if (status.value.coverage.status === 'unavailable') {
      const packageFact = owningPackage(normalized, snapshot.packages);
      return ok({
        status: 'unavailable',
        ...(packageFact === undefined ? {} : { package: packageFact }),
        inventoryIdentity: status.value.identity,
        project: snapshot.project,
        coverage: status.value.coverage,
        freshness: status.value.freshness,
        reasonCodes: status.value.coverage.reasonCodes,
        nextActions: status.value.nextActions,
      });
    }
    const packageFact = owningPackage(normalized, snapshot.packages);
    const shared = {
      ...(packageFact === undefined ? {} : { package: packageFact }),
      inventoryIdentity: status.value.identity,
      project: snapshot.project,
      coverage: status.value.coverage,
      freshness: status.value.freshness,
    };
    let excluded = false;
    try {
      const absolute = resolve(this.projectRoot, normalized);
      excluded = this.targets?.applyGlobalExcludes([absolute], this.projectRoot).length === 0;
    } catch {
      return ok({
        status: 'unavailable',
        ...shared,
        reasonCodes: [...status.value.coverage.reasonCodes, 'target-exclusion-failed'],
        nextActions: [
          'Review configured target exclusions before relying on this negative file lookup.',
        ],
      });
    }
    if (excluded) {
      return ok({
        status: 'excluded',
        ...shared,
        reasonCodes: ['file-excluded'],
        nextActions: ['Review global exclusions if this file should be analyzed.'],
      });
    }
    return ok({
      status: 'unknown',
      ...shared,
      reasonCodes: ['file-not-in-inventory'],
      nextActions: ['Verify the path or add the file to a configured target.'],
    });
  }

  private projectStatus(cache: InventoryCache): CodebaseInventoryStatus {
    const freshness = freshnessFor(cache);
    return {
      snapshot: cache.inventory.snapshot,
      identity: cache.inventory.snapshot.snapshotId,
      coverage: cache.inventory.snapshot.coverage,
      freshness,
      nextActions: inventoryNextActions(freshness),
    };
  }
}
