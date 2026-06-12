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

import { resolveEffectiveCloudConfig } from '@opensip-tools/config';
import {
  RunScope,
  createCapabilityRegistry,
  type ProjectContext,
  type ToolRegistry,
} from '@opensip-tools/core';
import { resolveSignalSink } from '@opensip-tools/output';

import { buildDatastoreThunk, getToolManifestsForRun } from '../cli-context.js';
import { buildTargets } from './build-targets.js';
import { composeAndValidateToolConfig } from './config-and-capabilities.js';
import { loadCliDefaults } from './cli-defaults.js';
import { wireCapabilityRegistry } from './config-and-capabilities.js';
import { loadOwningToolCapabilities } from './load-tool-capabilities.js';

import type { ToolPluginManifest } from '@opensip-tools/core';
import type { Logger } from '@opensip-tools/core';

const CLI_PACKAGE_NAME = 'opensip-tools';

/** Inputs required to build a fully wired per-run scope. */
export interface BuildPerRunScopeInput {
  readonly project: ProjectContext;
  readonly runId: string;
  readonly cwd: string;
  readonly cliDefaults: ReturnType<typeof loadCliDefaults>; // or narrow if we extract a type
  readonly registries: {
    readonly languages: any; // LanguageRegistry
    readonly tools: ToolRegistry;
  };
  readonly manifests: readonly ToolPluginManifest[];
  readonly apiKey?: string;
  readonly noCloud?: boolean;
  readonly logger: Logger;
  /**
   * Presentation state resolved by the hook before the scope is built:
   * the CLI package version and the cached newer-version string (if any).
   * Passed in — NOT derivable from `cliDefaults` (the `cli:` config block
   * carries no package version).
   */
  readonly ui: { readonly version: string; readonly update: string | undefined };
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
  const { project, runId, cwd, cliDefaults, registries, manifests, apiKey, noCloud, logger, ui } =
    input;

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
    ui: { bannerSize: cliDefaults.ui?.banner ?? 'mini', version: ui.version, update: ui.update },
  });

  // D7: each registered tool contributes its tool-specific subscope (e.g.
  // `scope.simulation`, `scope.graph`) BEFORE the scope is entered. IoC (M4):
  // the tool RETURNS its slot via `contributeScope()`; the kernel installs it
  // with `Object.assign` (registration order; a tool with no hook is skipped).
  for (const tool of tools.list()) {
    const contribution = tool.contributeScope?.();
    if (contribution) Object.assign(scope, contribution);
  }

  // §5.3 Phase 4: per-run capability registry (manifest domains → real registrars).
  const capabilities = wireCapabilityRegistry({
    tools,
    manifests,
    registry: createCapabilityRegistry(logger),
  });

  Object.assign(scope, {
    capabilities,
    toolConfig,
    targets,
    ...configDocumentSlot(project, configDocument),
  });

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

import { resolveUserPaths } from '@opensip-tools/core'; // for the cacheDir line if needed in future refinement
