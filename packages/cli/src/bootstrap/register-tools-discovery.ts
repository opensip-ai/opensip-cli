/**
 * register-tools-discovery — installed + authored tool admission and discovery.
 *
 * Extracted from register-tools.ts so the bundled registration path stays a
 * focused module under the file-length soft limit.
 */

import {
  admitTool,
  assertManifestMatchesTool,
  discoverToolPackagesFromAnchors,
  logger,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  loadToolManifest,
  type BootstrapDiagnosticsCollector,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
  type ToolDiscoverySource,
} from '@opensip-cli/core';

import {
  importToolRuntime,
  workerRuntimeImportPolicyFor,
  type ToolRuntimeLoad,
} from './admit-tool-package.js';
import { BUNDLED_TOOL_PACKAGES } from './bundled-manifest.js';
import { BOOTSTRAP_MODULE } from './constants.js';
import {
  recordInstalledCatchFailure,
  recordInstalledLoadFailure,
  recordInstalledManifestInvalid,
  recordInstalledTrustDenied,
} from './discovery-diagnostics.js';
import { synthesizeExternalTool } from './synthesize-external-tool.js';
import { isHostRuntimeImportForbidden } from './tool-provenance.js';
import { isInstalledToolTrusted } from './tool-trust.js';

import type { ToolAdmission } from './tool-admission-types.js';

const BUNDLED_PACKAGE_NAMES = new Set<string>(BUNDLED_TOOL_PACKAGES);

/**
 * Run the admission gate over a discovered INSTALLED tool package before its
 * module is imported. Installed tools are best-effort: incompatible or malformed
 * ambient packages skip with diagnostics rather than crashing unrelated commands.
 */
function admitInstalledTool(
  pkg: { readonly name: string; readonly packageDir: string },
  builtInIds: ReadonlySet<string>,
  collector?: BootstrapDiagnosticsCollector,
): ToolAdmission | undefined {
  const manifest = loadToolManifest('installed', pkg.packageDir);
  if (manifest === undefined) {
    recordInstalledManifestInvalid(pkg.name, collector);
    logger.warn({
      evt: 'cli.tool.manifest_invalid',
      module: BOOTSTRAP_MODULE,
      name: pkg.name,
    });
    return undefined;
  }
  // ADR-0060 Phase 1: stale injected copies of bundled first-party tools are
  // distribution noise when the bundled path already admitted the same id.
  // When OPENSIP_CLI_SKIP_BUNDLED dropped bundled admission, the installed
  // package is the intentional takeover path — do not skip it here.
  if (BUNDLED_PACKAGE_NAMES.has(pkg.name) && builtInIds.has(manifest.id)) {
    logger.debug({
      evt: 'cli.tool.bundled_installed_copy_skipped',
      module: BOOTSTRAP_MODULE,
      packageName: pkg.name,
      packageDir: pkg.packageDir,
    });
    return undefined;
  }
  if (builtInIds.has(manifest.id)) return undefined;

  const result = admitTool({
    manifest,
    source: 'installed',
    dir: pkg.packageDir,
    packageName: pkg.name,
    explicitlyRequested: false,
  });
  if (result.decision !== 'admit') return undefined;
  return { provenance: result.provenance, manifest: result.manifest };
}

/**
 * Emit the best-effort stderr line + structured warning for a discovered
 * INSTALLED tool whose runtime failed to load. Each failure reason maps to its
 * own diagnostic while preserving the installed leg's skip-not-crash posture.
 */
/** Record + structured log when an installed tool is skipped by the trust gate. */
export function emitInstalledTrustDenied(
  toolId: string,
  packageName: string,
  packageDir: string,
  collector?: BootstrapDiagnosticsCollector,
): void {
  recordInstalledTrustDenied(toolId, packageName, packageDir, collector);
  logger.warn({
    evt: 'cli.tool.installed_trust_denied',
    module: BOOTSTRAP_MODULE,
    toolId,
    packageName,
    packageDir,
  });
}

export function emitInstalledLoadFailure(
  name: string,
  load: Extract<ToolRuntimeLoad, { ok: false }>,
  collector?: BootstrapDiagnosticsCollector,
): void {
  recordInstalledLoadFailure(name, load, collector);
  if (load.reason === 'no-entry') {
    logger.warn({ evt: 'cli.tool.no_entry', module: BOOTSTRAP_MODULE, name });
    return;
  }
  if (load.reason === 'invalid-shape') {
    logger.warn({
      evt: 'cli.tool.invalid_shape',
      module: BOOTSTRAP_MODULE,
      name,
    });
    return;
  }
  logger.warn({
    evt: 'cli.tool.load_failed',
    module: BOOTSTRAP_MODULE,
    name,
    error: load.detail,
  });
}

export interface DiscoveryOptions {
  /**
   * Ordered tool-discovery sources (precedence: first wins on duplicate
   * name). Built by {@link buildToolDiscoverySources} at the composition
   * root; passed in here so this function reads no ambient HOME/cwd state
   * and stays unit-testable with explicit anchors.
   */
  readonly sources: readonly ToolDiscoverySource[];
  /** Injectable env for installed-tool trust (bootstrap-time; defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Optional bootstrap diagnostics sink (defaults to the process-wide buffer). */
  readonly bootstrapDiagnostics?: BootstrapDiagnosticsCollector;
}

/**
 * Build the ordered tool-discovery sources. Order is precedence
 * (first-occurrence-wins on duplicate name):
 *
 *   1. project-local `.runtime/plugins/tool`  — `plugin add --project`
 *   2. project tree (walk up from cwd)          — plain `npm install @tool`
 *   3. user-global `~/.opensip-cli/plugins/tool` — `plugin add` (default)
 *   4. CLI install dir (walk up)                 — `npm i -g @tool`
 *
 * A project-local pin therefore shadows a user-global install of the same
 * tool. Project-root resolution is best-effort: an unresolvable context
 * (e.g. running outside any project) simply contributes no `.runtime`
 * source.
 */
export function buildToolDiscoverySources(
  cwd: string,
  cliInstallDir: string,
): ToolDiscoverySource[] {
  const sources: ToolDiscoverySource[] = [];
  try {
    const project = resolveProjectContext({ cwd, cwdExplicit: false });
    if (project.scope === 'project') {
      sources.push({
        dir: resolveProjectPaths(project.projectRoot).pluginsDir('tool'),
        mode: 'scanDir',
      });
    }
  } catch {
    // @swallow-ok no resolvable project context (e.g. running outside any
    // project) → contribute no project-local tool source. Best-effort by
    // documented contract; see the JSDoc on buildToolDiscoverySources.
  }
  sources.push(
    { dir: cwd, mode: 'walkUp' },
    { dir: resolveUserPaths().pluginsDir('tool'), mode: 'scanDir' },
    { dir: cliInstallDir, mode: 'walkUp' },
  );
  return sources;
}

/**
 * Discover and register third-party tool packages from npm — any
 * `package.json` declaring `opensipTools.kind === 'tool'`. Built-in
 * ids are skipped to avoid double-registration warnings. Discovery spans
 * the supplied sources (the user-global tool host dir, the project tree +
 * its `.runtime` tool host dir, and the CLI install dir — see
 * {@link buildToolDiscoverySources}).
 *
 * Each discovered package runs through the SAME `admitTool` gate the
 * bundled path uses (launch, Phase 3) BEFORE its module is imported:
 * the static `package.json#opensipTools` manifest is read with source
 * `'installed'`, the compatibility gate runs, and only an `admit` verdict
 * proceeds to import + register. An installed tool is best-effort
 * `explicitlyRequested: false`, so an incompatible one `skip`s (logged)
 * rather than failing the whole CLI — a stray incompatible plugin must not
 * take fit/graph/sim down. Admitted tools' `ToolProvenance` is pushed onto
 * the optional `provenance` collector for Phase 4's `plugin list`.
 *
 * @param provenance Optional sink for admitted tools' provenance records.
 */
async function registerDiscoveredInstalledPackage(
  pkg: { readonly name: string; readonly packageDir: string },
  args: {
    readonly registry: ToolRegistry;
    readonly builtInIds: ReadonlySet<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly registeredStableIds: ReadonlySet<string>;
    readonly provenance: ToolProvenance[];
    readonly manifests: ToolPluginManifest[];
    readonly bootstrapDiagnostics?: BootstrapDiagnosticsCollector;
  },
): Promise<void> {
  const admission = admitInstalledTool(pkg, args.builtInIds, args.bootstrapDiagnostics);
  if (admission === undefined) return;

  if (!isInstalledToolTrusted(admission.manifest.id, args.env)) {
    emitInstalledTrustDenied(
      admission.manifest.id,
      pkg.name,
      pkg.packageDir,
      args.bootstrapDiagnostics,
    );
    return;
  }

  // ADR-0054 M4-G (capstone): in the HOST, NEVER import the external runtime —
  // register a manifest-derived synthetic Tool (command shells from the static
  // manifest; the worker imports the real runtime + runs the handler when a
  // command dispatches). The drift guard does not run host-side (there is no
  // runtime to compare; the manifest IS the host source of truth). Inside the
  // dispatch WORKER (`OPENSIP_CLI_IN_TOOL_WORKER=1`) the import path runs — the
  // isolation boundary where the untrusted runtime legitimately loads.
  if (isHostRuntimeImportForbidden(args.env)) {
    // Synchronous void registration (no import in the host); `void` marks the
    // floating call as deliberately non-promise (the synthesize path never awaits).
    void registerSyntheticExternalTool(args, admission, {
      sourcePackage: pkg.name,
    });
    return;
  }

  const load = await importToolRuntime(pkg.packageDir, workerRuntimeImportPolicyFor('installed'));
  if (!load.ok) {
    emitInstalledLoadFailure(pkg.name, load, args.bootstrapDiagnostics);
    return;
  }
  if (args.builtInIds.has(load.tool.metadata.name ?? load.tool.metadata.id)) return;
  // Stable-UUID collision (ADR-0048): skip a re-discovered copy of an already-
  // registered tool (see discoverAndRegisterToolPackages JSDoc).
  if (args.registeredStableIds.has(load.tool.metadata.id)) return;

  assertManifestMatchesTool(admission.manifest, load.tool);

  args.registry.register(load.tool, { sourcePackage: pkg.name });
  args.provenance.push(admission.provenance);
  args.manifests.push(admission.manifest);
}

/**
 * ADR-0054 M4-G host path: register the manifest-derived synthetic Tool for an
 * admitted EXTERNAL tool. Honors the same stable-UUID collision + built-in skip
 * the import path applies, keyed on the synthetic tool's `metadata.id`
 * (`stableId ?? id`) so a re-discovered copy is deduped identically.
 */
function registerSyntheticExternalTool(
  args: {
    readonly registry: ToolRegistry;
    readonly builtInIds: ReadonlySet<string>;
    readonly registeredStableIds: ReadonlySet<string>;
    readonly provenance: ToolProvenance[];
    readonly manifests: ToolPluginManifest[];
  },
  admission: ToolAdmission,
  opts?: { readonly sourcePackage?: string },
): void {
  const tool = synthesizeExternalTool(admission.manifest);
  if (args.builtInIds.has(tool.metadata.name ?? tool.metadata.id)) return;
  if (args.registeredStableIds.has(tool.metadata.id)) return;
  args.registry.register(tool, opts?.sourcePackage === undefined ? undefined : opts);
  args.provenance.push(admission.provenance);
  args.manifests.push(admission.manifest);
}

export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
): Promise<void> {
  const discovered = discoverToolPackagesFromAnchors(opts.sources);

  // Stable-UUID collision guard (ADR-0048): a discovered package whose runtime
  // `metadata.id` (the stable UUID) is already registered is the SAME tool
  // re-discovered via a stray anchor — e.g. a second copy of `@opensip-cli/*`
  // in a node_modules ABOVE the project root. The human-name skip alone misses
  // it when the two copies disagree on `metadata.name` (e.g. one built before
  // the verb-rename), which would otherwise double-register and trip the
  // session-replay duplicate guard. UUID is identity; skip on a UUID match.
  const registeredStableIds = new Set(registry.list().map((t) => t.metadata.id));

  const env = opts.env ?? process.env;
  const bootstrapDiagnostics = opts.bootstrapDiagnostics;

  for (const pkg of discovered) {
    try {
      await registerDiscoveredInstalledPackage(pkg, {
        registry,
        builtInIds,
        env,
        registeredStableIds,
        provenance,
        manifests,
        bootstrapDiagnostics,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      recordInstalledCatchFailure(pkg.name, msg, bootstrapDiagnostics);
      logger.warn({
        evt: 'cli.tool.load_failed',
        module: BOOTSTRAP_MODULE,
        name: pkg.name,
        error: msg,
      });
    }
  }
}
