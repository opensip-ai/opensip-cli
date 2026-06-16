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

import { join } from 'node:path';

import { resolveEffectiveCloudConfig } from '@opensip-cli/config';
import {
  createCapabilityRegistry,
  type LanguageRegistry,
  type Logger,
  PluginIncompatibleError,
  type ProjectContext,
  resolveUserPaths,
  RunScope,
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

import type { loadCliDefaults } from './cli-defaults.js';

const FORBIDDEN_SCOPE_CONTRIBUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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
    apiKey,
    noCloud,
    logger,
    ui,
  } = input;

  const { languages, tools } = registries;

  // ADR-0008: select the cloud signal sink for this run.
  const signalSink = resolveSignalSink({
    apiKey,
    cloud: resolveEffectiveCloudConfig(cliDefaults.cloud),
    noCloud,
    cacheDir: join(resolveUserPaths().userHomeDir, 'cache'), // note: resolveUserPaths is from core
  });

  // ADR-0023 Phase 4: compose + STRICT-validate config before building the
  // scope (a typo in any tool namespace → CONFIGURATION_ERROR); resolved
  // config rides the scope (tools read scope.toolConfig.<namespace>).
  const { config: toolConfig, document: configDocument } = composeAndValidateToolConfig({
    tools,
    manifests,
    configPath: project.scope === 'project' ? project.configPath : undefined,
    env: process.env,
  });

  // ADR-0037: build the host file-targeting accessor from the SAME single
  // validated config document the composer already read (ADR-0023: one
  // reader — `buildTargets` is a pure builder, never a second `readYamlFile`).
  const targets = buildTargets({ document: configDocument });

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
    datastore: buildDatastoreThunk(project, logger),
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
  });

  // Lifecycle diagnostics: record wiring steps (contributeScope + capabilities)
  // on the bus *before* enterScope. These ride the eventual CommandOutcome so
  // --json consumers and the uniform diagnostics snapshot see the full
  // per-run construction (addresses architecture review findings on observability
  // of steps 6/7 and blast-radius files).
  const contributing = tools.list().filter((t) => !!t.contributeScope);
  scope.diagnostics.event('load', 'debug', `${contributing.length} tool(s) contributed subscope`, {
    tools: contributing.map((t) => t.metadata.id ?? t.metadata.name),
  });
  scope.diagnostics.counter('tools.subscope_contributions', contributing.length);

  // D7: each registered tool contributes its tool-specific subscope (e.g.
  // `scope.simulation`, `scope.graph`) BEFORE the scope is entered. IoC (M4):
  // the tool RETURNS its slot via `contributeScope()`; the kernel installs it
  // with `Object.assign` (registration order; a tool with no hook is skipped).
  for (const tool of tools.list()) {
    const contribution = tool.contributeScope?.();
    if (contribution) installScopeContribution(scope, tool, contribution);
  }

  // §5.3 Phase 4: per-run capability registry (manifest domains → real registrars).
  const capabilities = wireCapabilityRegistry({
    tools,
    manifests,
    registry: createCapabilityRegistry(logger),
  });

  const wired = capabilities.listDomains().map((d) => d.id);
  scope.diagnostics.event('load', 'debug', `wired ${wired.length} capability domain(s)`, {
    domains: wired,
  });
  scope.diagnostics.counter('capabilities.wired', wired.length);

  // Host-resolved verdict policies (ADR-0035) are derived once from the fully
  // precedence-resolved toolConfig (flag > env > file > defaults) and stamped
  // onto the scope. All readers (result builders, gate compare, internal "is
  // error?" logic) inside this run must use the stamped value (or a helper that
  // reads it) so the numbers that drove `envelope.verdict.passed` and the exit
  // code are identical everywhere. See fitness `resolveFitVerdictPolicy`.
  const fitnessBlock: Record<string, unknown> | undefined = toolConfig
    ? ((toolConfig as Record<string, unknown>).fitness as Record<string, unknown> | undefined)
    : undefined;
  const fitnessVerdictPolicy = {
    failOnErrors: typeof fitnessBlock?.failOnErrors === 'number' ? fitnessBlock.failOnErrors : 1,
    failOnWarnings:
      typeof fitnessBlock?.failOnWarnings === 'number' ? fitnessBlock.failOnWarnings : 0,
  };

  Object.assign(scope, {
    capabilities,
    toolConfig,
    targets,
    fitnessVerdictPolicy,
    ...configDocumentSlot(project, configDocument),
  });

  // Also surface the config validation result for the uniform lifecycle view.
  const toolConfigNamespaces = tools.list().filter((t) => !!t.config).length;
  scope.diagnostics.event(
    'validate',
    'debug',
    `config composed for ${toolConfigNamespaces} tool namespace(s)`,
  );

  return scope;
}

// Helper duplicated from pre-action-hook for now (small, can be shared later if it grows).
function configDocumentSlot(
  project: { readonly scope: string; readonly configPath: string | undefined },
  configDocument: unknown,
): { configDocument?: Record<string, unknown> } {
  return project.scope === 'project' && project.configPath !== undefined
    ? { configDocument: configDocument as Record<string, unknown> }
    : {};
}

// Note: resolveUserPaths is used above but was in the original hook import from core.
// In real extraction we would import it here. For this focused GA step we keep the
// construction close to original to minimize diff while still thinning the hook.
// The important win is that pre-action-hook no longer contains the 60+ lines of
// scope assembly + wiring.
