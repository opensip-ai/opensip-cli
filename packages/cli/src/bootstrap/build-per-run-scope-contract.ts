import type { loadCliDefaults } from './cli-defaults.js';
import type { PolicyAuditCollector } from './policy-audit.js';
import type { StartupTimingEvent } from './startup-timing.js';
import type { RuntimeLeaseLifecycle } from '../commands/host-runtime-access.js';
import type {
  CliDiagnostic,
  LanguageRegistry,
  Logger,
  ProjectContext,
  RuntimeCommandInventory,
  ToolPluginManifest,
  ToolProvenance,
  ToolRegistry,
} from '@opensip-cli/core';

/** Inputs required to build a fully wired per-run scope. */
export interface BuildPerRunScopeInput {
  readonly project: ProjectContext;
  readonly runId: string;
  readonly cwd: string;
  /**
   * Top-level command name the run started under (e.g. `graph`, `fit`) — the
   * first segment of the invoked command path.
   */
  readonly parentCommand: string;
  /** Owning tool id of the dispatched command. */
  readonly toolName: string;
  readonly cliDefaults: ReturnType<typeof loadCliDefaults>;
  readonly registries: {
    readonly languages: LanguageRegistry;
    readonly tools: ToolRegistry;
  };
  readonly manifests: readonly ToolPluginManifest[];
  /** Provenance paired index-wise with the admitted manifests. */
  readonly provenance: readonly ToolProvenance[];
  /** Startup diagnostics gathered before this scope was built. */
  readonly bootstrapDiagnostics?: readonly CliDiagnostic[];
  /** Process-startup timings re-emitted into normal command diagnostics. */
  readonly startupTimings?: readonly StartupTimingEvent[];
  /** Policy audit events gathered before this run scope existed. */
  readonly bootstrapPolicyAudit?: PolicyAuditCollector;
  readonly apiKey?: string;
  readonly noCloud?: boolean;
  readonly logger: Logger;
  /** Plain host+Tool command inventory projected by the composition root. */
  readonly runtimeCommands?: RuntimeCommandInventory;
  /** Presentation state resolved before the scope is built. */
  readonly ui: {
    readonly version: string;
    readonly update: string | undefined;
  };
  /**
   * Ambient datastore capability selected by trusted bootstrap state, never by
   * config, manifest, command option, or RPC input.
   */
  readonly datastoreAccess: 'local' | 'local-explicit-only' | 'host-rpc-only' | 'none';
  /** CLI-only lease ownership consumed by persistence teardown. */
  readonly runtimeLeaseLifecycle?: RuntimeLeaseLifecycle;
}
