// @fitness-ignore-file performance-anti-patterns -- sequential await across discovered tool packages preserves load order for plugin-conflict detection; bounded by installed plugin count
import {
  assertManifestMatchesTool,
  discoverAuthoredToolSidecars,
  discoverToolPackagesFromAnchors,
  logger,
  PluginIncompatibleError,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
  type ToolDiscoverySource,
} from '@opensip-cli/core';

import { hostRuntimeImportPolicyFor, importToolRuntime } from './admit-tool-package.js';
import {
  admitProjectLocalTool,
  admitUserGlobalTool,
  type AuthoredAdmission,
} from './authored-tool-admission.js';
import { admitInstalledTool, emitInstalledLoadFailure } from './installed-tool-admission.js';
import { BOOTSTRAP_MODULE } from './register-tools-shared.js';

export interface DiscoveryOptions {
  /**
   * Ordered tool-discovery sources (precedence: first wins on duplicate
   * name). Built by {@link buildToolDiscoverySources} at the composition
   * root; passed in here so this function reads no ambient HOME/cwd state
   * and stays unit-testable with explicit anchors.
   */
  readonly sources: readonly ToolDiscoverySource[];
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
export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
): Promise<void> {
  // `builtInIds` is the set of already-registered bundled-tool *human ids* (manifest.id)
  // to skip on a name collision (launch — passed explicitly by the composition root, which
  // derives it from the bundled MANIFESTS it just loaded; compare against runtime
  // metadata.name for the human key).
  const discovered = discoverToolPackagesFromAnchors(opts.sources);

  for (const pkg of discovered) {
    try {
      // Compatibility gate BEFORE import (launch). `undefined` means the
      // gate skipped it (or it's a built-in id); an admission means import +
      // register as before.
      const admission = admitInstalledTool(pkg, builtInIds);
      if (admission === undefined) continue;

      // Load the runtime through the SHARED dynamic-import path (launch) — the
      // same `importToolRuntime` the bundled path uses. Resolves the entry
      // from `packageDir` so a tool living in a host dir off the CLI's own
      // module-resolution path still loads. An installed tool is best-effort:
      // any load failure skips-with-diagnostic (it must not take fit/graph/sim
      // down), in contrast to the bundled path's fail-closed.
      const load = await importToolRuntime(pkg.packageDir, hostRuntimeImportPolicyFor('installed'));
      if (!load.ok) {
        emitInstalledLoadFailure(pkg.name, load);
        continue;
      }
      // builtInIds holds human ids (from bundled manifests); compare against runtime human name
      if (builtInIds.has(load.tool.metadata.name ?? load.tool.metadata.id)) continue;

      // Drift guard — the SAME manifest⇔runtime identity check the bundled and
      // authored legs run. For an installed tool a mismatch throws into the
      // surrounding catch (skip-with-diagnostic posture), never crashing the CLI.
      assertManifestMatchesTool(admission.manifest, load.tool);

      registry.register(load.tool, { sourcePackage: pkg.name });
      // Record provenance + manifest only now that the tool actually
      // registered — `plugin list` and the per-run capability registry must
      // never include a tool whose runtime failed to load (parity with the
      // bundled/authored legs, which also record after registration).
      provenance.push(admission.provenance);
      manifests.push(admission.manifest);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip: failed to load tool ${pkg.name}: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.load_failed',
        module: BOOTSTRAP_MODULE,
        name: pkg.name,
        error: msg,
      });
    }
  }
}

/**
 * Discover + admit + register AUTHORED Tool sidecars from the two authored
 * roots, then dynamic-import each admitted runtime through the shared
 * `importToolRuntime` seam — the same admit → import → register path the
 * bundled and installed legs travel (ADR-0027; this is the leg that makes the
 * dormant {@link admitProjectLocalTool} live).
 *
 * Two roots, two trust postures:
 *   - **global** (`~/.opensip-cli/tools/`) → {@link admitUserGlobalTool},
 *     trusted-by-default.
 *   - **project** (`<project>/opensip-cli/tools/`) → {@link admitProjectLocalTool},
 *     deny-by-default (allowlist via `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`).
 *
 * Global is processed FIRST so a project-authored tool cannot shadow a same-id
 * global one — matching the `~/.opensip-cli/plugins` precedence note in
 * {@link buildToolDiscoverySources} (first-writer-wins via the registry).
 * `builtInIds` are skipped so an authored tool never shadows a bundled one.
 *
 * **Trust-before-import.** For each candidate, the admit step (which EMBEDS the
 * trust decision — deny-by-default inside `admitProjectLocalTool`) runs to
 * completion BEFORE `importToolRuntime`. A non-allowlisted project tool THROWS
 * `PluginIncompatibleError` (exit 5) here, propagated out of the walk: it must
 * fail the run loudly — that is the clone-protection contract.
 *
 * **Error-posture asymmetry (deliberate).** An un-allowlisted *project* tool is
 * fail-closed by policy (clone-risk; the user must opt in). A *global* tool that
 * fails to load is also fail-closed (the user explicitly authored it into
 * `$HOME`). This differs from the *installed* npm leg, where a stray bad plugin
 * skips-with-diagnostic so it can't take fit/graph/sim down — authored tools are
 * first-party-intent, installed tools are ambient.
 *
 * @param registry The per-invocation tool registry to populate.
 * @param opts.projectAuthoredDir `resolveProjectPaths(root).authoredToolsDir`,
 *   or `undefined` when there is no resolvable project context.
 * @param opts.globalAuthoredDir `resolveUserPaths().authoredToolsDir`.
 * @param opts.env Environment carrying the project allowlist (default
 *   `process.env`); injectable for tests.
 * @param builtInIds Bundled-tool ids to skip on a name collision.
 * @param provenance Sink for admitted authored tools' provenance records.
 * @param manifests Sink for admitted authored tools' manifests (§5.3).
 * @throws {PluginIncompatibleError} for an un-allowlisted project tool, or any
 *   authored tool whose sidecar/runtime is missing/incompatible (fail-closed).
 */
export async function discoverAndRegisterAuthoredTools(
  registry: ToolRegistry,
  opts: {
    readonly projectAuthoredDir?: string;
    readonly globalAuthoredDir: string;
    readonly env?: NodeJS.ProcessEnv;
  },
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
): Promise<void> {
  // Global FIRST (trusted-by-default), then project (deny-by-default).
  for (const candidate of discoverAuthoredToolSidecars(opts.globalAuthoredDir)) {
    await admitAndRegisterAuthored({
      registry,
      admission: admitUserGlobalTool({ dir: candidate.dir }),
      dir: candidate.dir,
      builtInIds,
      provenance,
      manifests,
    });
  }
  if (opts.projectAuthoredDir !== undefined) {
    for (const candidate of discoverAuthoredToolSidecars(opts.projectAuthoredDir)) {
      // admitProjectLocalTool embeds the deny-by-default trust gate; a
      // non-allowlisted tool THROWS here, BEFORE importToolRuntime below.
      await admitAndRegisterAuthored({
        registry,
        admission: admitProjectLocalTool({ dir: candidate.dir, env: opts.env }),
        dir: candidate.dir,
        builtInIds,
        provenance,
        manifests,
      });
    }
  }
}

/**
 * The inputs to {@link admitAndRegisterAuthored}: the per-invocation registry +
 * collectors, the already-resolved admission, and the candidate's directory. A
 * single params object (rather than a positional list) keeps the register-step
 * narrow and lets both authored legs call it with one readable record.
 */
interface AuthoredRegisterArgs {
  readonly registry: ToolRegistry;
  readonly admission: AuthoredAdmission;
  readonly dir: string;
  readonly builtInIds: ReadonlySet<string>;
  readonly provenance: ToolProvenance[];
  readonly manifests: ToolPluginManifest[];
}

/**
 * Shared register-step for an already-ADMITTED authored tool: skip a
 * built-in-id collision, dynamic-import the runtime (fail-closed on failure —
 * an authored tool is first-party-intent), run the manifest⇔runtime drift
 * guard, register, and record provenance + manifest. Admission (incl. the trust
 * decision) has already happened by the time this is called — so import here
 * never precedes a trust decision.
 *
 * @throws {PluginIncompatibleError} when the authored tool's runtime fails to
 *   load via the plugin path — an authored tool is first-party-intent, so a
 *   load failure is fail-closed (surfaced), never silently skipped.
 */
async function admitAndRegisterAuthored(args: AuthoredRegisterArgs): Promise<void> {
  const { registry, admission, dir, builtInIds, provenance, manifests } = args;
  const { provenance: prov, manifest } = admission;
  // Never shadow a bundled tool (defense in depth; the registry also dedupes).
  if (builtInIds.has(prov.id)) return;

  const load = await importToolRuntime(dir, hostRuntimeImportPolicyFor(prov.source));
  if (!load.ok) {
    const detailSuffix = load.detail ? `: ${load.detail}` : '';
    throw new PluginIncompatibleError(
      `${prov.source} tool '${prov.id}' failed to load via the plugin path (${load.reason}${detailSuffix})`,
      { diagnostic: `authored tool runtime load failed: ${load.reason}` },
    );
  }

  // Drift guard: the static sidecar and the runtime tool are two declarations
  // of the same identity — catch a sidecar that fell out of sync.
  assertManifestMatchesTool(manifest, load.tool);

  registry.register(load.tool);
  provenance.push(prov);
  manifests.push(manifest);
}
