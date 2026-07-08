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
  }

  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  dispose(): void {
    this.parseCache.dispose();
    this.recipeUnitConfig.clear();
    for (const fn of this.disposers.splice(0)) {
      try {
        fn();
      } catch {
        /* @swallow-ok a disposer failure must not abort teardown */
      }
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
