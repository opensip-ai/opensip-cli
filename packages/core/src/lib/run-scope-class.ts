/**
 * @fileoverview RunScope class — leaf module for the per-invocation scope type.
 *
 * Extracted from `run-scope.ts` so `scope-storage.ts` can type the ALS slot
 * without forming a file-level cycle (`run-scope` re-exports the ALS seam).
 */

import { LanguageParseCache } from '../languages/parse-cache-class.js';
import { LanguageRegistry } from '../languages/registry.js';
import { noopSignalSink } from '../signals/signal-sink.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  EMPTY_RUNTIME_COMMAND_INVENTORY,
  type RuntimeCommandInventory,
} from '../tools/runtime-command-inventory.js';

import { BootstrapDiagnosticsCollector } from './bootstrap-diagnostics.js';
import { DiagnosticsBus } from './diagnostics-bus.js';
import { logger as defaultLogger } from './logger.js';

import type { CliDiagnostic } from './cli-diagnostic.js';
import type { Logger } from './logger.js';
import type { ProjectContext } from './project-context.js';
import type { RunCorrelation } from './run-correlation.js';
import type { DataStoreThunk, RecipeUnitConfigSlot, ToolScope } from './scope-types.js';
import type { UiContext } from './ui-context.js';
import type { CapabilityPackAdmission } from '../plugins/capability-discovery-types.js';
import type { SignalSink } from '../signals/signal-sink.js';
import type { ToolPluginManifest, ToolProvenance } from '../tools/manifest.js';

class DefaultRecipeUnitConfigSlot implements RecipeUnitConfigSlot {
  private store: Record<string, Record<string, unknown>> = {};

  get<T extends Record<string, unknown>>(slug: string): T | undefined {
    return this.store[slug] as T | undefined;
  }

  set(slug: string, config: Record<string, unknown>): void {
    this.store[slug] = config;
  }

  setAll(config: Record<string, Record<string, unknown>>): void {
    this.store = { ...config };
  }

  clear(): void {
    this.store = {};
  }
}

/** Constructor input for {@link RunScope}: registries, services, and per-run identifiers. */
export interface RunScopeOptions {
  readonly logger?: Logger;
  readonly parseCache?: LanguageParseCache;
  readonly projectContext?: ProjectContext;
  readonly datastore?: DataStoreThunk;
  readonly tools?: ToolRegistry;
  readonly languages?: LanguageRegistry;
  readonly ui?: UiContext;
  readonly runId?: string;
  readonly signalSink?: SignalSink;
  readonly toolManifests?: readonly ToolPluginManifest[];
  readonly toolProvenance?: readonly ToolProvenance[];
  readonly telemetry?: Record<string, unknown>;
  readonly correlation?: RunCorrelation;
  readonly bootstrapDiagnostics?: readonly CliDiagnostic[];
  readonly trustPolicy?: unknown;
  readonly policyAudit?: unknown;
  readonly capabilityAdmission?: CapabilityPackAdmission;
  /**
   * Plain complete host+Tool command inventory for this invocation.
   * Defaults to an empty inventory; CLI bootstrap injects the real surface.
   * Never holds live handlers or Commander objects.
   */
  readonly runtimeCommands?: RuntimeCommandInventory;
}

/**
 * Per-invocation execution scope.
 *
 * Construct exactly once per CLI invocation. Pass via
 * `ToolCliContext.scope` (Phase 5). Tools read `cli.scope.foo`
 * instead of reaching into module globals (the T1 invariant).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional: the class merges with the `interface RunScope extends ToolScope` below to gain the augmentable ScopeContribution slots for reading.
export class RunScope {
  readonly logger: Logger;
  readonly parseCache: LanguageParseCache;
  readonly recipeUnitConfig: RecipeUnitConfigSlot;
  readonly projectContext: ProjectContext | undefined;
  readonly datastore: DataStoreThunk;
  readonly tools: ToolRegistry;
  readonly languages: LanguageRegistry;
  readonly ui: UiContext | undefined;
  readonly runId: string;
  readonly signalSink: SignalSink;
  readonly diagnostics: DiagnosticsBus;
  readonly toolManifests: readonly ToolPluginManifest[];
  readonly toolProvenance: readonly ToolProvenance[];
  readonly telemetry: Record<string, unknown>;
  readonly correlation: RunCorrelation | undefined;
  readonly bootstrapDiagnostics: BootstrapDiagnosticsCollector;
  readonly trustPolicy: unknown;
  readonly policyAudit: unknown;
  readonly capabilityAdmission: CapabilityPackAdmission | undefined;
  /** Plain host+Tool command inventory (default empty). */
  readonly runtimeCommands: RuntimeCommandInventory;

  private readonly disposers: (() => void)[] = [];

  constructor(opts: RunScopeOptions = {}) {
    this.logger = opts.logger ?? defaultLogger;
    this.parseCache = opts.parseCache ?? new LanguageParseCache();
    this.recipeUnitConfig = new DefaultRecipeUnitConfigSlot();
    this.projectContext = opts.projectContext;
    // eslint-disable-next-line unicorn/no-useless-undefined -- explicit no-store sentinel matches the prior `cli.datastore` contract (tools cast to `DataStore | undefined`).
    this.datastore = opts.datastore ?? (() => undefined);
    this.tools = opts.tools ?? new ToolRegistry();
    this.languages = opts.languages ?? new LanguageRegistry();
    this.ui = opts.ui;
    this.runId = opts.runId ?? '';
    this.signalSink = opts.signalSink ?? noopSignalSink;
    this.diagnostics = new DiagnosticsBus(this.runId);
    this.toolManifests = opts.toolManifests ?? [];
    this.toolProvenance = opts.toolProvenance ?? [];
    this.telemetry = opts.telemetry ?? {};
    this.correlation = opts.correlation;
    this.bootstrapDiagnostics = new BootstrapDiagnosticsCollector();
    for (const diagnostic of opts.bootstrapDiagnostics ?? []) {
      this.bootstrapDiagnostics.record(diagnostic);
    }
    this.trustPolicy = opts.trustPolicy;
    this.policyAudit = opts.policyAudit;
    this.capabilityAdmission = opts.capabilityAdmission;
    this.runtimeCommands = opts.runtimeCommands ?? EMPTY_RUNTIME_COMMAND_INVENTORY;
  }

  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  dispose(): void {
    // Teardown is a safety boundary, not a convenience callback. A corrupted
    // or Tool-mutated cache/config object must not prevent persistence close
    // proof and runtime-lease release in the registered disposer tail. A
    // disposer failure must not abort teardown — but it is LOGGED, never
    // silently dropped: a swallowed audit-flush/datastore-close failure would
    // be exactly the silent evidence loss disposal exists to prevent.
    try {
      this.parseCache.dispose();
    } catch (error) {
      this.logDisposeFailure('parse-cache', error);
    }
    try {
      this.recipeUnitConfig.clear();
    } catch (error) {
      this.logDisposeFailure('recipe-unit-config', error);
    }
    for (const fn of this.disposers.splice(0)) {
      try {
        fn();
      } catch (error) {
        this.logDisposeFailure('registered-disposer', error);
      }
    }
  }

  /** Teardown must complete even when the log sink itself is gone. */
  private logDisposeFailure(stage: string, error: unknown): void {
    try {
      this.logger.warn({
        evt: 'core.scope.dispose.failed',
        module: 'core:run-scope',
        stage,
        err: error instanceof Error ? error.message : String(error),
      });
    } catch {
      /* @swallow-ok teardown outranks the diagnostic */
    }
  }
}

/**
 * Declaration-merge: `RunScope` IS-A `ToolScope` (the Tool-facing view)
 * plus the `tools` registry it adds. Extending `ToolScope` here also
 * brings in the augmentable `ScopeContribution` slots, so
 * `currentScope()?.simulation` / `?.graph` stay readable on a RunScope.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- merge target: gives the RunScope class the ToolScope + augmentable ScopeContribution members for reads.
export interface RunScope extends ToolScope {}
