/**
 * bootstrap — performs the one-time (per-process) STARTUP phase registrations
 * (language adapters + tool admission via the uniform dynamic path) and
 * returns the populated registries + provenance/manifests to the composition
 * root.
 *
 * The full 10-step canonical lifecycle (including the PER-RUN steps that
 * happen later in the preAction hook) is documented in `tool-lifecycle.ts`.
 * This module owns steps 1-4 (discover/compat/trust/import for bundled +
 * installed + authored) plus the mount seam re-export.
 *
 * See tool-lifecycle.ts for the ordered steps and phase split.
 */

import {
  logger,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type CliDiagnostic,
  type LanguageRegistry,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';
import { initTelemetry } from '../telemetry/sdk-init.js';

import {
  getBootstrapDiagnosticsBuffer,
  resetBootstrapDiagnosticsBuffer,
  takeBootstrapDiagnostics,
} from './bootstrap-diagnostics-buffer.js';
import { BOOTSTRAP_MODULE } from './constants.js';
import { registerLanguageAdapters } from './register-language-adapters.js';
import {
  BUNDLED_TOOL_PACKAGES,
  registerFirstPartyTools,
  discoverAndRegisterToolPackages,
  discoverAndRegisterAuthoredTools,
  buildToolDiscoverySources,
} from './register-tools.js';
import { shouldSkipInstalledToolDiscovery } from './skip-installed-plugins.js';

// Re-export only the symbols the CLI composition root (`index.ts`) consumes.
export { mountAllToolCommands, EXPECTED_SCAFFOLDING_TOOL_IDS } from './register-tools.js';
// The shared admission callable (ADR-0041: one validator, four consumers) —
// consumed by the tools command group (validate/install) and the
// admission-parity / bundled-conformance tests.
export {
  admitToolPackage,
  importToolRuntime,
  type AdmissionReport,
  type AdmissionSection,
  type AdmissionSectionResult,
  type AdmitToolPackageOptions,
} from './admit-tool-package.js';
export { renderResult } from './render.js';
export { maybeOpenReport } from './report.js';
export { installPreActionHook } from './pre-action-hook.js';
export { buildCommandRegistrationInput } from './build-command-registration-input.js';
export { buildHostPlanes } from './host-planes.js';
export { isRootVersionRequest } from './root-version.js';

export interface BootstrapOptions {
  readonly langRegistry: LanguageRegistry;
  readonly toolRegistry: ToolRegistry;
  /**
   * User args after the binary (`process.argv.slice(2)`). Used for bootstrap-
   * time global flags (e.g. `--no-plugins`) that must be honored before Commander
   * parses.
   */
  readonly argv?: readonly string[];
  /**
   * The CLI's own install directory. Anchors discovery of graph adapters
   * and of tools installed as siblings of a global `opensip-cli`.
   */
  readonly projectDir: string;
  /**
   * The user's working directory (process.cwd()). Anchors project-local
   * and user-global tool discovery (a plain `npm install @tool`, the
   * project's `.runtime/plugins/tool`, and `~/.opensip-cli/plugins/tool`).
   */
  readonly cwd: string;
  /**
   * `import.meta.url` of the CLI entry. Used to init telemetry as early as
   * possible (reads the CLI package version for the `service.version` resource
   * attribute). Telemetry init is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT`
   * is set, so this is inert for standalone runs.
   */
  readonly cliEntryUrl: string;
}

/**
 * One-shot bootstrap: register language adapters, register the first-
 * party tools, and discover-and-register every third-party tool +
 * @opensip-cli/graph-* adapter pack. Datastore is NOT opened here —
 * it's a lazy getter on ToolCliContext (cli-context.ts), so dry-runs
 * and error paths that never read `cli.datastore` don't materialise
 * `.runtime/datastore.sqlite`.
 *
 * Graph adapter discovery runs BEFORE `mountAllToolCommands`: the
 * graph tool's `register()` method assumes adapters are already
 * available so its lang-adapter registry isn't empty when the first
 * `pickAdapter()` lands during a real run. PR 1a of plan
 * docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
 */
export async function bootstrapCli(opts: BootstrapOptions): Promise<BootstrapResult> {
  // Telemetry first — before any tool runs — so provider registration happens
  // once per process ahead of the first stage span. Hard no-op unless the OTLP
  // endpoint env var is set (see telemetry/sdk-init.ts), so standalone startup
  // is byte-for-byte unaffected.
  initTelemetry(opts.cliEntryUrl);
  resetBootstrapDiagnosticsBuffer();
  registerLanguageAdapters(opts.langRegistry);

  // Launch: bundled + installed tools both flow through the shared
  // `admitTool` gate (register-tools.ts) and contribute a `ToolProvenance`
  // record into this collector. It's a plain array threaded by value — no
  // module singleton — handed back to the composition root so Phase 4's
  // `plugin list` can surface source / identity / manifestHash.
  const provenance: ToolProvenance[] = [];
  // §5.3 (launch): collect the admitted tools' manifests alongside provenance
  // so the composition root can seed the per-run capability registry with each
  // manifest's declared domains.
  const manifests: ToolPluginManifest[] = [];
  // Launch: bundled tools load through the same dynamic-import path as installed
  // tools, so registration is async — awaited before discovery so the bundled
  // manifests are loaded before we derive the built-in skip-set from them.
  // A bundled tool listed in OPENSIP_CLI_SKIP_BUNDLED is NOT loaded as bundled,
  // so an installed/project-local copy of the same id can take over — the
  // install-source-independence escape hatch (the bundled tool is one provenance,
  // not a privilege).
  // `.get` returns the spec's `default: []` when unset, so the list is always an
  // array (never undefined).
  const skipBundled = new Set(hostEnv.get<readonly string[]>('OPENSIP_CLI_SKIP_BUNDLED'));
  const bundledPackages = BUNDLED_TOOL_PACKAGES.filter(
    (pkg) => !skipBundled.has(pkg.replace('@opensip-cli/', '')),
  );
  await registerFirstPartyTools(opts.toolRegistry, provenance, manifests, bundledPackages);
  // The bundled-tool ids discovery must skip on a name collision, derived from
  // the manifests just loaded (not from an imported tool runtime — the host
  // holds none in the launch contract).
  const builtInIds = new Set(manifests.map((m) => m.id));
  const argv = opts.argv ?? [];
  if (shouldSkipInstalledToolDiscovery(argv)) {
    logger.info({
      evt: 'cli.tool.installed_discovery_skipped',
      module: BOOTSTRAP_MODULE,
      reason: argv.includes('--no-plugins') ? 'argv-no-plugins' : 'env-skip-installed',
    });
  } else {
    await discoverAndRegisterToolPackages(
      opts.toolRegistry,
      {
        sources: buildToolDiscoverySources(opts.cwd, opts.projectDir),
        bootstrapDiagnostics: getBootstrapDiagnosticsBuffer(),
      },
      builtInIds,
      provenance,
      manifests,
    );
  }
  // Authored Tool sidecars (ADR-0027 realization): global trusted-by-default +
  // project deny-by-default. Resolve the two authored roots — the global root
  // is always present; the project root is best-effort (an unresolvable
  // context contributes no project authored leg, mirroring
  // buildToolDiscoverySources). `builtInIds` stays the BUNDLED set (matching
  // the installed leg's contract); the registry's first-writer-wins dedupes an
  // authored-vs-installed same-id collision with a structured warning.
  const globalAuthoredDir = resolveUserPaths().authoredToolsDir;
  let projectAuthoredDir: string | undefined;
  try {
    const project = resolveProjectContext({
      cwd: opts.cwd,
      cwdExplicit: false,
    });
    if (project.scope === 'project') {
      projectAuthoredDir = resolveProjectPaths(project.projectRoot).authoredToolsDir;
    }
  } catch {
    // @swallow-ok no resolvable project context → no project authored leg
    // (best-effort, same contract as buildToolDiscoverySources).
  }
  await discoverAndRegisterAuthoredTools(
    opts.toolRegistry,
    { projectAuthoredDir, globalAuthoredDir, env: process.env },
    builtInIds,
    provenance,
    manifests,
  );
  // Graph adapters (and every other tool's capability domains) are no longer
  // discovered here. The pre-action hook drives the generic capability loader
  // per command for the invoked tool's declared domains (§5.3/§4.5) — no
  // host-coupled, eager, per-tool discovery at bootstrap.
  return {
    provenance,
    manifests,
    bootstrapDiagnostics: takeBootstrapDiagnostics(),
  };
}

/** What {@link bootstrapCli} hands back to the composition root. */
export interface BootstrapResult {
  /**
   * Provenance for every tool admitted through the compatibility gate
   * (bundled + installed), in registration order. Reachable by `plugin
   * list` (Phase 4) via the cli-context per-run holder.
   */
  readonly provenance: readonly ToolProvenance[];
  /**
   * Manifests for every tool admitted through the compatibility gate
   * (bundled + installed), in registration order. The composition root
   * seeds the per-run capability registry from these (§5.3) via the
   * cli-context per-run holder.
   */
  readonly manifests: readonly ToolPluginManifest[];
  /**
   * Typed bootstrap diagnostics gathered during startup discovery/load (ADR-0060).
   * Transferred onto the per-run {@link RunScope} by the composition root.
   */
  readonly bootstrapDiagnostics: readonly CliDiagnostic[];
}
