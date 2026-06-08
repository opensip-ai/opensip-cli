// @fitness-ignore-file detached-promises -- bootstrap calls the synchronous registerLanguageAdapters and awaits the async tool registration helpers (registerFirstPartyTools, discoverAndRegisterToolPackages) that the heuristic flags
/**
 * bootstrap — composition-root for the CLI.
 *
 * `bootstrapCli({ langRegistry, toolRegistry })` performs the side-effect-y
 * registrations the dispatcher needs before Commander is wired up:
 *
 *   1. Bundled language adapters land in the supplied `LanguageRegistry`.
 *   2. First-party tools (fitness / simulation / graph) land in the
 *      supplied `ToolRegistry`.
 *   3. Third-party tools — discovered via `discoverToolPackages` from
 *      core — are imported and registered as third-party. The built-in
 *      ids are skipped to avoid double-registration warnings.
 *   4. The project-local SQLite DataStore is opened so tools and CLI
 *      commands can persist sessions / baselines through it. Returned
 *      to the caller so the composition root can hand it to the
 *      `ToolCliContext` and the CLI-only commands.
 *
 * Discovery is async (dynamic `import()` of each tool package). The
 * caller awaits before walking the registry to mount Commander
 * subcommands so `--help` listings see every tool's commands.
 *
 * Datastore opening is sequenced AFTER tool / adapter registration so
 * registry side-effects (which never touch SQLite) land before the
 * file-system handle exists. If a tool's `register()` ever needs the
 * datastore at registration time, that's a contract change — flag it,
 * don't reorder silently.
 *
 * Barrel surface: only the symbols `index.ts` actually consumes are
 * re-exported from this barrel. Internal helpers (`mergeConfigDefaults`,
 * `loadCliDefaults`, `registerFirstPartyTools`, `BUNDLED_TOOL_PACKAGES`,
 * `registerLanguageAdapters`) stay in their files; bootstrap siblings and
 * tests import them directly. (User-global config I/O moved to
 * `@opensip-tools/config` in 2.10.1.) Audit 2026-05-23 M1.
 */

import { initTelemetry } from '../telemetry/sdk-init.js';

import { discoverAndRegisterGraphAdapterPackages } from './register-graph-adapters.js';
import { registerLanguageAdapters } from './register-language-adapters.js';
import {
  registerFirstPartyTools,
  discoverAndRegisterToolPackages,
  buildToolDiscoverySources,
} from './register-tools.js';

import type { LanguageRegistry, ToolPluginManifest, ToolProvenance, ToolRegistry } from '@opensip-tools/core';

// Re-export only the symbols the CLI composition root (`index.ts`) consumes.
// `mountToolCommands` is the named step-8 seam of the tool lifecycle (release
// 2.11.0, §5.4); it delegates to `mountAllToolCommands` (kept exported for the
// existing direct unit tests).
export { mountAllToolCommands } from './register-tools.js';
export { mountToolCommands } from './tool-lifecycle.js';
export { renderResult } from './render.js';
export { maybeOpenDashboard } from './dashboard.js';
export { installPreActionHook } from './pre-action-hook.js';

export interface BootstrapOptions {
  readonly langRegistry: LanguageRegistry;
  readonly toolRegistry: ToolRegistry;
  /**
   * The CLI's own install directory. Anchors discovery of graph adapters
   * and of tools installed as siblings of a global `opensip-tools`.
   */
  readonly projectDir: string;
  /**
   * The user's working directory (process.cwd()). Anchors project-local
   * and user-global tool discovery (a plain `npm install @tool`, the
   * project's `.runtime/plugins/tool`, and `~/.opensip-tools/plugins/tool`).
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
 * @opensip-tools/graph-* adapter pack. Datastore is NOT opened here —
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
  registerLanguageAdapters(opts.langRegistry);

  // Release 2.8.0: bundled + installed tools both flow through the shared
  // `admitTool` gate (register-tools.ts) and contribute a `ToolProvenance`
  // record into this collector. It's a plain array threaded by value — no
  // module singleton — handed back to the composition root so Phase 4's
  // `plugin list` can surface source / identity / manifestHash.
  const provenance: ToolProvenance[] = [];
  // §5.3 (2.10.0): collect the admitted tools' manifests alongside provenance
  // so the composition root can seed the per-run capability registry with each
  // manifest's declared domains.
  const manifests: ToolPluginManifest[] = [];
  // 3.0.0: bundled tools load through the same dynamic-import path as installed
  // tools, so registration is async — awaited before discovery so the bundled
  // manifests are loaded before we derive the built-in skip-set from them.
  await registerFirstPartyTools(opts.toolRegistry, provenance, manifests);
  // The bundled-tool ids discovery must skip on a name collision, derived from
  // the manifests just loaded (not from an imported tool runtime — the host
  // holds none in 3.0.0).
  const builtInIds = new Set(manifests.map((m) => m.id));
  await discoverAndRegisterToolPackages(
    opts.toolRegistry,
    { sources: buildToolDiscoverySources(opts.cwd, opts.projectDir) },
    builtInIds,
    provenance,
    manifests,
  );
  await discoverAndRegisterGraphAdapterPackages({ projectDir: opts.projectDir });
  return { provenance, manifests };
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
}
