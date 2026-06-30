/**
 * build-per-run-scope — thin, pure(ish) builder for the per-invocation RunScope.
 *
 * Extracted from pre-action-hook (and cli-context assembly) to address
 * composition-root concentration (GA architectural blocker #2).
 *
 * The hook remains the sequencer of high-level steps (project resolution,
 * bailouts, logger config, update nag). This builder owns the exact
 * scope-construction + wiring of:
 *   - signalSink (cloud)
 *   - toolConfig + configDocument (ADR-0023 one-reader)
 *   - targets (ADR-0037)
 *   - contributeScope from all registered tools
 *   - capability registry wiring
 *   - RunScope construction with explicit inputs
 *
 * Inputs are explicit so the builder is testable in isolation and the
 * hook stays focused on orchestration.
 */

import { basename, join } from 'node:path';

import { resolveApiKey, resolveEffectiveCloudConfig } from '@opensip-cli/config';
import {
  BootstrapDiagnosticsCollector,
  createCapabilityRegistry,
  currentTraceparent,
  isContributionWithDisposer,
  type CliDiagnostic,
  type LanguageRegistry,
  type Logger,
  PluginIncompatibleError,
  type ProjectContext,
  type RunCorrelation,
  resolveUserPaths,
  RunScope,
  resolveToolHooks,
  type ScopeContribution,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';
import { resolveSignalSink } from '@opensip-cli/output';

import { buildDatastoreThunk } from '../cli-context.js';

import { buildTargets } from './build-targets.js';
import { composeAndValidateToolConfig, wireCapabilityRegistry } from './config-and-capabilities.js';
import { shouldRunHookInHost } from './tool-provenance.js';

import type { loadCliDefaults } from './cli-defaults.js';
import type { StartupTimingEvent } from './startup-timing.js';

const FORBIDDEN_SCOPE_CONTRIBUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * @throws {PluginIncompatibleError} When a tool returns an invalid scope
 * contribution or attempts to overwrite an existing scope key.
 */
function installScopeContribution(
  scope: RunScope,
  tool: Tool,
  contribution: ScopeContribution,
): void {
  if (typeof contribution !== 'object' || contribution === null || Array.isArray(contribution)) {
    throw new PluginIncompatibleError(
      `tool '${tool.metadata.name || tool.metadata.id}' returned a non-object scope contribution`,
      {
        code: 'PLUGIN.SCOPE_CONTRIBUTION_INVALID',
        diagnostic: 'contributeScope must return a plain object',
      },
    );
  }

  for (const key of Object.keys(contribution)) {
    if (FORBIDDEN_SCOPE_CONTRIBUTION_KEYS.has(key)) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' returned forbidden scope key '${key}'`,
        {
          code: 'PLUGIN.SCOPE_CONTRIBUTION_FORBIDDEN_KEY',
          diagnostic: `forbidden scope key '${key}'`,
        },
      );
    }
    // `key in scope` (not `hasOwnProperty`) so prototype members are protected
    // too: `RunScope.dispose()` lives on the prototype, and an own-property
    // shadow would silently hijack `disposeCurrentScope()`. This also rejects
    // `Object.prototype` names; no namespaced tool subscope key collides with
    // those, so the stricter check has no legitimate false positive.
    if (key in scope) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' attempted to overwrite scope key '${key}'`,
        {
          code: 'PLUGIN.SCOPE_CONTRIBUTION_COLLISION',
          diagnostic: `scope key '${key}' already exists`,
        },
      );
    }
  }

  Object.assign(scope, contribution);
}

/** Inputs required to build a fully wired per-run scope. */
export interface BuildPerRunScopeInput {
  readonly project: ProjectContext;
  readonly runId: string;
  readonly cwd: string;
  /**
   * Top-level command name the run started under (e.g. `graph`, `fit`) — the
   * FIRST segment of the invoked command path, NOT a child's own
   * `graph-shard-worker`. Stamped into the assembled `RunCorrelation` so a child
   * worker can attribute itself to the parent command (B2 / GAP e).
   */
  readonly parentCommand: string;
  /**
   * Owning tool id of the dispatched command (e.g. `graph`, `fit`), resolved by
   * the bootstrap. Stamped into the assembled `RunCorrelation.tool`.
   */
  readonly toolName: string;
  readonly cliDefaults: ReturnType<typeof loadCliDefaults>; // or narrow if we extract a type
  readonly registries: {
    readonly languages: LanguageRegistry;
    readonly tools: ToolRegistry;
  };
  readonly manifests: readonly ToolPluginManifest[];
  /**
   * Provenance of the tools admitted this run, recorded by the bootstrap and
   * stamped onto the scope (paired index-wise with `manifests`) so host
   * commands read it via `currentScope()` rather than a module global.
   */
  readonly provenance: readonly ToolProvenance[];
  /**
   * Startup bootstrap diagnostics gathered before this scope was built (ADR-0060).
   */
  readonly bootstrapDiagnostics?: readonly CliDiagnostic[];
  /**
   * Process-startup phase timings gathered before Commander preAction entered
   * this run scope. Re-emitted here so normal CommandOutcome diagnostics carry
   * the same local timing facts as logs.
   */
  readonly startupTimings?: readonly StartupTimingEvent[];
  readonly apiKey?: string;
  readonly noCloud?: boolean;
  readonly logger: Logger;
  /**
   * Presentation state resolved by the hook before the scope is built:
   * the CLI package version and the cached newer-version string (if any).
   * Passed in — NOT derivable from `cliDefaults` (the `cli:` config block
   * carries no package version).
   */
  readonly ui: {
    readonly version: string;
    readonly update: string | undefined;
  };
}

/**
 * Build the per-run RunScope + perform the post-construction wiring
 * (contributeScope, capabilities, toolConfig, targets).
 *
 * This is the extracted builder. It is intentionally not 100% pure
 * (it calls into config resolution, signal sink selection, etc.)
 * but all inputs are explicit and side effects are contained.
 */
export function buildPerRunScope(input: BuildPerRunScopeInput): RunScope {
  const {
    project,
    runId,
    cliDefaults,
    registries,
    manifests,
    provenance,
    bootstrapDiagnostics,
    startupTimings,
    apiKey,
    noCloud,
    logger,
    ui,
  } = input;

  const { languages, tools } = registries;
  const scopeBootstrapDiagnostics = new BootstrapDiagnosticsCollector();
  for (const diagnostic of bootstrapDiagnostics ?? []) {
    scopeBootstrapDiagnostics.record(diagnostic);
  }

  // Resolve the effective cloud config ONCE — both the signal sink (ADR-0008)
  // and the correlation cloud-active gate (B2) read it; do not resolve twice.
  const effectiveCloud = resolveEffectiveCloudConfig(cliDefaults.cloud);

  // ADR-0008: select the cloud signal sink for this run.
  const signalSink = resolveSignalSink({
    apiKey,
    cloud: effectiveCloud,
    noCloud,
    cacheDir: join(resolveUserPaths().userHomeDir, 'cache'), // note: resolveUserPaths is from core
  });

  // B2: assemble the cloud-aware RunCorrelation here — the one place the
  // resolved cloud identity is in hand (library code deep in the tree cannot
  // re-resolve it by layering, so it reads `currentScope()?.correlation`).
  const { correlation, cloudActive, traceId } = assembleCorrelation({
    runId,
    tool: input.toolName,
    parentCommand: input.parentCommand,
    apiKey,
    noCloud,
    effectiveCloud,
    project,
    cwd: input.cwd,
  });

  // ADR-0023 Phase 4: compose + STRICT-validate config before building the
  // scope (a typo in any tool namespace → CONFIGURATION_ERROR); resolved
  // config rides the scope (tools read scope.toolConfig.<namespace>).
  const { config: toolConfig, document: configDocument } = composeAndValidateToolConfig({
    tools,
    manifests,
    // ADR-0054 M4-E: provenance drives the two-pass fold — bundled tools' Zod is
    // composed host-side; external tools validate from their manifest descriptor
    // (coarse, no Zod import); the deep Zod pass runs in the worker.
    provenance,
    configPath: project.scope === 'project' ? project.configPath : undefined,
    env: process.env,
    bootstrapDiagnostics: scopeBootstrapDiagnostics,
  });

  // ADR-0037: build the host file-targeting accessor from the SAME single
  // validated config document the composer already read (ADR-0023: one
  // reader — `buildTargets` is a pure builder, never a second `readYamlFile`).
  const targets = buildTargets({ document: configDocument });

  // Lazy datastore thunk; its `dispose` (registered on the scope below) closes
  // the cached SQLite connection on teardown — checkpointing/truncating the WAL
  // and freeing the handle, which otherwise leaked for the process lifetime.
  const datastoreThunk = buildDatastoreThunk(project, logger, input.parentCommand);
  const scope = new RunScope({
    logger,
    projectContext: project,
    languages,
    tools,
    signalSink,
    runId,
    // Closure-based lazy datastore. SQLite is materialised only on
    // first access. The thunk captures `project` so non-action paths
    // (post-action handlers, error printers) that read via
    // `getOrOpenDatastore()` find the same instance.
    datastore: datastoreThunk,
    // `graphCatalog` is NOT wired here — the graph tool installs it via its
    // `contributeScope()` hook (ADR-0085), so the host never statically imports
    // `@opensip-cli/graph` (install-source independence, ADR-0009/0027/0029).
    // Presentation settings the render paths read via currentScope()?.ui.
    // bannerSize stays an untyped string at the kernel boundary; the
    // cli-ui render sites narrow it with normalizeBannerSize.
    // bannerSize stays derivable from config; version/update are resolved by
    // the hook (package version + cached update-check result) and passed in.
    ui: {
      bannerSize: cliDefaults.ui?.banner ?? 'mini',
      version: ui.version,
      update: ui.update,
    },
    // Per-run admitted-tool facts, recorded by the bootstrap. Stamped here (not
    // a module global) so host commands (`plugin list`, `tools list`, `tools
    // uninstall`) read them via `currentScope()` — the single source of truth.
    toolManifests: manifests,
    toolProvenance: provenance,
    bootstrapDiagnostics: scopeBootstrapDiagnostics.list(),
    // B2: the cloud-aware correlation bag, read downstream via
    // `currentScope()?.correlation` and forwarded into spawned/forked children.
    correlation,
  });

  // Close the datastore on scope teardown — the "consumer responsibility"
  // RunScope.dispose() documents. No-op when no command opened it.
  scope.onDispose(datastoreThunk.dispose);

  for (const timing of startupTimings ?? []) {
    scope.diagnostics.event('load', 'debug', `startup phase '${timing.name}' completed`, {
      source: 'startup',
      phase: timing.name,
      durationMs: timing.durationMs,
      sinceStartMs: timing.sinceStartMs,
      ...(timing.skipped === true ? { skipped: true } : {}),
    });
  }

  // Observability of the assembly step (consistent with the contributeScope /
  // capabilities diagnostics below). Do NOT log the `repo` VALUE at debug — it
  // can be a filesystem path; log the boolean `hasRepo` instead.
  scope.diagnostics.event('load', 'debug', 'run correlation assembled', {
    tool: correlation.tool,
    parentCommand: correlation.parentCommand,
    cloudActive,
    hasTraceId: traceId !== undefined,
    hasRepo: correlation.repo !== undefined,
  });

  // Lifecycle diagnostics: record wiring steps (contributeScope + capabilities)
  // on the bus *before* enterScope. These ride the eventual CommandOutcome so
  // --json consumers and the uniform diagnostics snapshot see the full
  // per-run construction (addresses architecture review findings on observability
  // of steps 6/7 and blast-radius files).
  // ADR-0054 M4-F: the HOST process never executes an EXTERNAL tool's
  // `contributeScope` (running its runtime closure is the load-time hole the ADR
  // rejects). External subscopes are contributed worker-side — the dispatch
  // worker re-runs this SAME builder with the host-skip INACTIVE, so the
  // dispatched external tool's subscope is installed there (the isolation
  // boundary). Bundled tools contribute in-host exactly as before. The
  // diagnostics count only the tools whose hook actually runs in-host.
  const contributing = tools
    .list()
    .filter((t) => !!resolveToolHooks(t).contributeScope && shouldRunHookInHost(t, provenance));
  scope.diagnostics.event('load', 'debug', `${contributing.length} tool(s) contributed subscope`, {
    tools: contributing.map((t) => t.metadata.id ?? t.metadata.name),
  });
  scope.diagnostics.counter('tools.subscope_contributions', contributing.length);

  // D7: each registered tool contributes its tool-specific subscope (e.g.
  // `scope.simulation`, `scope.graph`) BEFORE the scope is entered. IoC (M4):
  // the tool RETURNS its slot via `contributeScope()`; the kernel installs it
  // with `Object.assign` (registration order; a tool with no hook is skipped).
  //
  // Disposer seam (parallel-tool-invocations Phase 1): a tool that owns a
  // per-run resource needing teardown returns the wrapper form
  // (`{ contribution, onDispose }`); we install `contribution` and register
  // `onDispose` on `scope.onDispose(...)` so `dispose()` reclaims the resource.
  // The bare-`ScopeContribution` form (graph/simulation) carries no disposer.
  for (const tool of contributing) {
    const result = resolveToolHooks(tool).contributeScope?.();
    if (!result) continue;
    if (isContributionWithDisposer(result)) {
      installScopeContribution(scope, tool, result.contribution);
      if (result.onDispose) scope.onDispose(result.onDispose);
    } else {
      installScopeContribution(scope, tool, result);
    }
  }

  // §5.3 Phase 4: per-run capability registry (manifest domains → real registrars).
  // M4-F: pass provenance so the registry installs an external tool's REAL
  // registrar in-host only when the host-skip is inactive (i.e. in the worker).
  const capabilities = wireCapabilityRegistry({
    tools,
    manifests,
    registry: createCapabilityRegistry(logger),
    provenance,
  });

  const wired = capabilities.listDomains().map((d) => d.id);
  scope.diagnostics.event('load', 'debug', `wired ${wired.length} capability domain(s)`, {
    domains: wired,
  });
  scope.diagnostics.counter('capabilities.wired', wired.length);

  Object.assign(scope, {
    capabilities,
    toolConfig,
    targets,
    ...configDocumentSlot(project, configDocument),
  });

  // Also surface the config validation result for the uniform lifecycle view.
  const toolConfigNamespaces = tools.list().filter((t) => !!resolveToolHooks(t).config).length;
  scope.diagnostics.event(
    'validate',
    'debug',
    `config composed for ${toolConfigNamespaces} tool namespace(s)`,
  );

  return scope;
}

/** Inputs for {@link assembleCorrelation}. */
interface AssembleCorrelationInput {
  readonly runId: string;
  readonly tool: string;
  readonly parentCommand: string;
  readonly apiKey?: string;
  readonly noCloud?: boolean;
  readonly effectiveCloud: { readonly sync?: boolean; readonly endpoint?: string } | undefined;
  readonly project: ProjectContext;
  readonly cwd: string;
}

/** Assemble the cloud-aware {@link RunCorrelation} bag and diagnostics facts. */
function assembleCorrelation(input: AssembleCorrelationInput): {
  readonly correlation: RunCorrelation;
  readonly cloudActive: boolean;
  readonly traceId: string | undefined;
} {
  const cloudActive =
    resolveApiKey(input.apiKey) !== undefined &&
    input.noCloud !== true &&
    input.effectiveCloud?.sync !== false;

  const repoBaseDir = input.project.scope === 'project' ? input.project.projectRoot : input.cwd;
  const repo = cloudActive ? basename(repoBaseDir) || undefined : undefined;

  const traceId = currentTraceparent();

  const correlation: RunCorrelation = {
    runId: input.runId,
    tool: input.tool,
    parentCommand: input.parentCommand,
    ...(traceId ? { traceId } : {}),
    ...(repo ? { repo } : {}),
  };

  return { correlation, cloudActive, traceId };
}

function configDocumentSlot(
  project: { readonly scope: string; readonly configPath: string | undefined },
  configDocument: unknown,
): { configDocument?: Record<string, unknown> } {
  return project.scope === 'project' && project.configPath !== undefined
    ? { configDocument: configDocument as Record<string, unknown> }
    : {};
}
