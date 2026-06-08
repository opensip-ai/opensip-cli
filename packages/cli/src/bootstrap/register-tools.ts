// @fitness-ignore-file performance-anti-patterns -- sequential await across discovered tool packages preserves load order for plugin-conflict detection; bounded by installed plugin count
// @fitness-ignore-file file-length-limit -- bootstrap composition root: one cohesive tool-admission lifecycle (resolve bundled dir → loadToolManifest → admitTool, across bundled / installed / project-local sources) plus discovery-source ordering and command mounting; splitting fragments the unified admission dispatch (cf. graph.ts's identical waiver for its subcommand-dispatch surface).
/**
 * register-tools — populate the kernel `ToolRegistry` with first-party
 * tools (fitness / simulation / graph) plus any third-party tool
 * packages discovered on disk.
 *
 * Extracted from `index.ts`. The bundled-id skip below is defense in
 * depth: as of Layer 1 Phase 1 the registry itself enforces
 * first-writer-wins on duplicate ids and logs a structured
 * `tool.registry.duplicate` warning. Keeping the explicit guard avoids
 * a noisy warning when a third-party package happens to ship under a
 * built-in id.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type CliProgram } from '@opensip-tools/contracts';
import {
  admitTool,
  assertManifestMatchesTool,
  discoverToolPackagesFromAnchors,
  loadToolManifest,
  logger,
  PluginIncompatibleError,
  PROJECT_LOCAL_MANIFEST_FILE,
  readToolPackageMetadata,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type Tool,
  type ToolCliContext,
  type ToolDiscoverySource,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-tools/core';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import { isProjectLocalToolTrusted } from './tool-trust.js';
import { isValidTool } from './validate-tool.js';

/** `module` field on every structured log event emitted from this file. */
const BOOTSTRAP_MODULE = 'cli:bootstrap';

/**
 * Bundled first-party tool PACKAGES — declared as direct deps of
 * opensip-tools. Order is registration order (and thus help/listing order).
 *
 * 3.0.0 GA cutover: these are package NAMES, not imported tool runtimes. The
 * host no longer statically `import`s `fitnessTool`/`graphTool`/`simulationTool`
 * — bundled tools are resolved on disk and loaded by DYNAMIC IMPORT through the
 * exact same manifest → `admitTool` → import → register path an installed or
 * project-local tool travels (north-star §2.1, Figure 7). "Bundled" is now a
 * provenance/trust posture, not a privileged load path: install-source
 * independence is structural, not merely tested (`no-bootstrap-tool-import`
 * guards this file against a static tool-runtime import creeping back).
 */
export const BUNDLED_TOOL_PACKAGES: readonly string[] = [
  '@opensip-tools/fitness',
  '@opensip-tools/simulation',
  '@opensip-tools/graph',
];

/** Used to resolve the bundled engine package dirs from the CLI's own module graph. */
const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve a bundled tool's PACKAGE DIR — the directory whose `package.json`
 * carries the `opensipTools` manifest.
 *
 * The `./package.json` subpath is not declared in each engine's `exports`,
 * so `require.resolve('<pkg>/package.json')` throws. Instead we resolve the
 * package's MAIN entry (a bare-name resolve, always permitted by `exports`)
 * and walk up to the nearest ancestor directory that has a `package.json`
 * whose `name` matches `packageName`. That ancestor IS the tool's own
 * package dir under both the source layout and pnpm's workspace-injected
 * `node_modules` layout (verified against fitness/simulation/graph here).
 *
 * @returns the resolved package directory, or `undefined` when the package
 *   cannot be resolved (should never happen for a bundled direct dep).
 */
function resolveBundledPackageDir(packageName: string): string | undefined {
  let resolvedEntry: string;
  try {
    resolvedEntry = requireFromHere.resolve(packageName);
  } catch (error) {
    // A bundled direct dep failing to resolve is a packaging fault — log it
    // so the subsequent fail-closed throw is diagnosable, then signal the
    // unresolved state to the caller (which raises PluginIncompatibleError).
    logger.debug({
      evt: 'cli.tool.bundled_unresolved',
      module: BOOTSTRAP_MODULE,
      packageName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown };
        if (json.name === packageName) return dir;
      } catch {
        // @swallow-ok unreadable package.json on the walk-up — keep climbing.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The outcome of importing a tool package's runtime module. A discriminated
 * result (never throws) so each caller maps it to its own policy — bundled
 * fails closed, installed skips-with-diagnostic.
 */
type ToolRuntimeLoad =
  | { readonly ok: true; readonly tool: Tool }
  | {
      readonly ok: false;
      readonly reason: 'no-entry' | 'invalid-shape' | 'import-failed';
      readonly detail?: string;
    };

/**
 * Resolve a tool package's entry, DYNAMIC-IMPORT it, and validate the exported
 * `tool` shape. This is the ONE runtime-load path every installation source
 * travels (3.0.0 GA, north-star Figure 7): no static `import` of a tool runtime
 * survives in the host — a bundled tool is imported by its resolved entry path
 * exactly as an installed one is. Import is by `pathToFileURL(meta.mainEntry)`,
 * not the bare package name, so a tool living in a host dir off the CLI's own
 * module-resolution path still loads. A third-party tool is an untrusted
 * boundary, so `isValidTool` gates the exported symbol before it is touched.
 *
 * Never throws: returns a discriminated result the caller acts on.
 */
async function importToolRuntime(dir: string): Promise<ToolRuntimeLoad> {
  const meta = readToolPackageMetadata(dir);
  if (!meta) return { ok: false, reason: 'no-entry' };
  let mod: { tool?: unknown };
  try {
    mod = (await import(pathToFileURL(meta.mainEntry).href)) as { tool?: unknown };
  } catch (error) {
    return {
      ok: false,
      reason: 'import-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isValidTool(mod.tool)) return { ok: false, reason: 'invalid-shape' };
  return { ok: true, tool: mod.tool };
}

/**
 * Register the bundled first-party tools into the supplied registry, each one
 * flowing through the SAME admit → dynamic-import → register path the external
 * path uses (3.0.0 GA cutover — replaces the 2.8.0 static-import + gate path).
 *
 * Per package name: `resolveBundledPackageDir` → `loadToolManifest('bundled')`
 * → `admitTool({ source: 'bundled', explicitlyRequested: true })` →
 * `importToolRuntime` (dynamic import + shape validation) → drift guard →
 * `registry.register`. A bundled tool ships with the CLI, so it is always
 * explicitly present: a missing/incompatible manifest or a runtime that fails
 * to load is FAIL-CLOSED (never a silent skip). The recorded `ToolProvenance`
 * (source `'bundled'`, trusted-by-shipping) and manifest are pushed onto the
 * optional collectors so the composition root can surface provenance
 * (`plugin list`) and seed the per-run capability registry (§5.3).
 *
 * @param registry The per-invocation tool registry to populate.
 * @param provenance Optional sink for the admitted tools' provenance records.
 * @param manifests Optional sink for the admitted tools' manifests (§5.3).
 * @param packages The bundled package names to load (defaults to
 *   {@link BUNDLED_TOOL_PACKAGES}; injectable so the fail-closed paths are
 *   testable with fixture packages).
 * @throws {PluginIncompatibleError} when a bundled tool cannot be resolved,
 *   has no conformant manifest, is out of range, or its runtime fails to load
 *   — mapped to `EXIT_CODES.PLUGIN_INCOMPATIBLE` (exit 5) by the CLI boundary.
 */
export async function registerFirstPartyTools(
  registry: ToolRegistry,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
  packages: readonly string[] = BUNDLED_TOOL_PACKAGES,
): Promise<void> {
  for (const packageName of packages) {
    const dir = resolveBundledPackageDir(packageName);
    if (dir === undefined) {
      throw new PluginIncompatibleError(
        `bundled tool '${packageName}' could not be resolved on disk; its manifest is unreadable`,
        { diagnostic: 'package directory not resolvable' },
      );
    }

    const manifest = loadToolManifest('bundled', dir);
    if (manifest === undefined) {
      // A bundled tool MUST ship a conformant manifest (the tool-has-manifest
      // guardrail backstops this at CI; at runtime a missing manifest is
      // fail-closed, not a silent skip).
      throw new PluginIncompatibleError(
        `bundled tool '${packageName}' has no conformant package.json#opensipTools manifest`,
        { diagnostic: 'manifest missing or malformed' },
      );
    }

    const result = admitTool({
      manifest,
      source: 'bundled',
      dir,
      packageName,
      // A bundled tool ships with the CLI; it is always explicitly present,
      // so an incompatible manifest fails the run rather than skipping.
      explicitlyRequested: true,
    });

    if (result.decision === 'fail-closed') {
      throw new PluginIncompatibleError(
        `bundled tool '${manifest.id}' is incompatible: ${result.diagnostic ?? 'compatibility gate rejected it'}`,
        { diagnostic: result.diagnostic },
      );
    }
    if (result.decision === 'skip') {
      // Should not happen for an in-range bundled tool, but never silently
      // drop a bundled tool — surface it loudly.
      throw new PluginIncompatibleError(
        `bundled tool '${manifest.id}' was skipped by the compatibility gate: ${result.diagnostic ?? 'unknown reason'}`,
        { diagnostic: result.diagnostic },
      );
    }

    // Load the runtime by DYNAMIC IMPORT — the same path installed tools use.
    // The host holds no static reference to fit/graph/sim (3.0.0). A bundled
    // tool that fails to load is a packaging fault → fail-closed.
    const load = await importToolRuntime(dir);
    if (!load.ok) {
      const detailSuffix = load.detail ? `: ${load.detail}` : '';
      throw new PluginIncompatibleError(
        `bundled tool '${manifest.id}' failed to load via the plugin path (${load.reason}${detailSuffix})`,
        { diagnostic: `bundled tool runtime load failed: ${load.reason}` },
      );
    }

    // Defensive drift guard: the static manifest and the runtime tool are two
    // declarations of the same identity. Catch a manifest that fell out of sync
    // with the tool's command surface before it confuses users.
    assertManifestMatchesTool(manifest, load.tool);

    registry.register(load.tool);
    provenance.push(result.provenance);
    // Record the manifest so the pre-action-hook can register this tool's
    // declared capability domains into the per-run capability registry
    // (release 2.10.0, §5.3).
    manifests.push(manifest);
  }
}

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
 *   3. user-global `~/.opensip-tools/plugins/tool` — `plugin add` (default)
 *   4. CLI install dir (walk up)                 — `npm i -g @tool`
 *
 * A project-local pin therefore shadows a user-global install of the same
 * tool. Project-root resolution is best-effort: an unresolvable context
 * (e.g. running outside any project) simply contributes no `.runtime`
 * source.
 */
export function buildToolDiscoverySources(cwd: string, cliInstallDir: string): ToolDiscoverySource[] {
  const sources: ToolDiscoverySource[] = [];
  try {
    const project = resolveProjectContext({ cwd, cwdExplicit: false });
    if (project.scope === 'project') {
      sources.push({ dir: resolveProjectPaths(project.projectRoot).pluginsDir('tool'), mode: 'scanDir' });
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
 * Run the 2.8.0 admission gate over a discovered INSTALLED tool package
 * before its module is imported. Reads the static
 * `package.json#opensipTools` manifest and runs the shared `admitTool` gate
 * (source `'installed'`, best-effort `explicitlyRequested: false` so an
 * incompatible installed tool skips rather than failing the whole CLI).
 *
 * Returns:
 *   - `'reject'`  — skip this package (gate skipped it, or its id collides
 *                   with a built-in). The gate already logged the reason.
 *   - `'proceed'` — continue to import + register. This covers both an
 *                   admitted manifest AND a manifest-less package (grace
 *                   window: pre-2.8.0 third-party tools keep loading off the
 *                   `kind: 'tool'` discovery marker alone).
 *
 * On `'proceed'` for an admitted manifest, the tool's `ToolProvenance` is
 * pushed onto `provenance` for Phase 4's `plugin list`.
 */
function admitInstalledTool(
  pkg: { readonly name: string; readonly packageDir: string },
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[],
  manifests: ToolPluginManifest[],
): 'reject' | 'proceed' {
  const manifest = loadToolManifest('installed', pkg.packageDir);
  if (manifest === undefined) return 'proceed'; // grace window — legacy import path
  if (builtInIds.has(manifest.id)) return 'reject';

  const result = admitTool({
    manifest,
    source: 'installed',
    dir: pkg.packageDir,
    packageName: pkg.name,
    // Best-effort: discovery alone can't tell whether THIS run targets this
    // tool's command, so default false → incompatible installed tools skip.
    explicitlyRequested: false,
  });
  if (result.decision !== 'admit') return 'reject';
  provenance.push(result.provenance);
  // Record the admitted manifest so the pre-action-hook can register an
  // installed tool's declared capability domains too (§5.3).
  manifests.push(manifest);
  return 'proceed';
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
 * bundled path uses (release 2.8.0, Phase 3) BEFORE its module is imported:
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
/**
 * Emit the best-effort stderr line + structured warning for a discovered
 * INSTALLED tool whose runtime failed to load. Each `ToolRuntimeLoad` failure
 * reason maps to its own message + event (preserving the 2.8.0 diagnostics) —
 * an installed tool's load failure skips it, never crashing the CLI.
 */
function emitInstalledLoadFailure(
  name: string,
  load: Extract<ToolRuntimeLoad, { ok: false }>,
): void {
  if (load.reason === 'no-entry') {
    process.stderr.write(`opensip-tools: tool package ${name} has no resolvable entry point — skipping\n`);
    logger.warn({ evt: 'cli.tool.no_entry', module: BOOTSTRAP_MODULE, name });
    return;
  }
  if (load.reason === 'invalid-shape') {
    process.stderr.write(`opensip-tools: tool package ${name} does not export a valid \`tool\` — skipping\n`);
    logger.warn({ evt: 'cli.tool.invalid_shape', module: BOOTSTRAP_MODULE, name });
    return;
  }
  process.stderr.write(`opensip-tools: failed to load tool ${name}: ${load.detail ?? 'import failed'}\n`);
  logger.warn({ evt: 'cli.tool.load_failed', module: BOOTSTRAP_MODULE, name, error: load.detail });
}

export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
): Promise<void> {
  // `builtInIds` is the set of already-registered bundled-tool ids to skip on
  // a name collision (3.0.0 — passed explicitly by the composition root, which
  // derives it from the bundled MANIFESTS it just loaded; the host holds no
  // imported tool runtime to read `tool.metadata.id` from).
  const discovered = discoverToolPackagesFromAnchors(opts.sources);

  for (const pkg of discovered) {
    try {
      // Compatibility gate BEFORE import (release 2.8.0). `'reject'` means the
      // gate skipped it (or it's a built-in id); `'proceed'` means import +
      // register as before (manifest absent → grace window, or admitted).
      if (admitInstalledTool(pkg, builtInIds, provenance, manifests) === 'reject') continue;

      // Load the runtime through the SHARED dynamic-import path (3.0.0) — the
      // same `importToolRuntime` the bundled path uses. Resolves the entry
      // from `packageDir` so a tool living in a host dir off the CLI's own
      // module-resolution path still loads. An installed tool is best-effort:
      // any load failure skips-with-diagnostic (it must not take fit/graph/sim
      // down), in contrast to the bundled path's fail-closed.
      const load = await importToolRuntime(pkg.packageDir);
      if (!load.ok) {
        emitInstalledLoadFailure(pkg.name, load);
        continue;
      }
      if (builtInIds.has(load.tool.metadata.id)) continue;
      registry.register(load.tool, { sourcePackage: pkg.name });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: failed to load tool ${pkg.name}: ${msg}\n`);
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
 * Admit (or reject) a single PROJECT-LOCAL executable tool under the
 * deny-by-default trust policy (release 2.8.0, Phase 3 Task 3.2).
 *
 * A project-local tool is authored code under `<project>/opensip-tools/…`
 * declaring its identity via a JSON sidecar (`opensip-tool.manifest.json`).
 * It is read + gated WITHOUT importing its module:
 *
 *   1. `loadToolManifest('project-local', dir)` — identity only, no code run.
 *   2. Trust check — {@link isProjectLocalToolTrusted}. Not allowlisted ⇒
 *      throw {@link PluginIncompatibleError} (fail-closed, exit 5) before any
 *      import. Allowlisted ⇒ run the compatibility gate; an incompatible
 *      explicitly-trusted tool is likewise fail-closed.
 *
 * Returns the admitted tool's `ToolProvenance` on success. Full
 * project-local tool DISCOVERY (walking the authored tree) is intentionally
 * light in 2.8.0; this is the reusable admission policy a discovery caller
 * routes each candidate through — the trust decision always precedes import.
 *
 * @throws {PluginIncompatibleError} when the tool has no conformant sidecar
 *   manifest, is not allowlisted, or is compatibility-incompatible.
 */
export function admitProjectLocalTool(args: {
  readonly dir: string;
  readonly env?: NodeJS.ProcessEnv;
}): ToolProvenance {
  const manifest = loadToolManifest('project-local', args.dir);
  if (manifest === undefined) {
    throw new PluginIncompatibleError(
      `project-local tool at '${args.dir}' has no conformant ${PROJECT_LOCAL_MANIFEST_FILE} sidecar`,
      { diagnostic: 'manifest missing or malformed' },
    );
  }

  // Trust decision FIRST — deny-by-default, before any compatibility maths
  // and (critically) before the tool's module could ever be imported.
  if (!isProjectLocalToolTrusted(manifest.id, args.env)) {
    throw new PluginIncompatibleError(
      `project-local tool '${manifest.id}' is not trusted to load (deny-by-default). ` +
        `Allowlist it via OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS='${manifest.id}' to admit it.`,
      { diagnostic: 'project-local tool not allowlisted (deny-by-default)' },
    );
  }

  const result = admitTool({
    manifest,
    source: 'project-local',
    dir: args.dir,
    // An allowlisted project-local tool was explicitly trusted by the user,
    // so an incompatible one fails the run rather than skipping silently.
    explicitlyRequested: true,
  });
  if (result.decision !== 'admit') {
    throw new PluginIncompatibleError(
      `project-local tool '${manifest.id}' is incompatible: ${result.diagnostic ?? 'compatibility gate rejected it'}`,
      { diagnostic: result.diagnostic },
    );
  }
  return result.provenance;
}

/**
 * Walk the registry and mount each tool's Commander subcommands. This is
 * **step 8** of the tool lifecycle (release 2.11.0, §5.4) — see
 * {@link runToolLifecycle}.
 *
 * Two mount paths, by tool shape:
 *
 *   - **Declarative (preferred)** — the tool declares `commandSpecs`; the host
 *     mounts each spec via `mountCommandSpec(program, spec, ctx)` (Phase 1) and
 *     SKIPS `register()`. The tool never touches Commander.
 *   - **Legacy fallback** — the tool has no `commandSpecs`; the host calls
 *     `tool.register(cli)` and emits a structured `cli.tool.register_deprecated`
 *     event (the raw-Commander path is removed in 3.0.0). fit/graph/sim mount
 *     via this fallback until their Phase 3-5 migration.
 *
 * Failures are isolated per tool — one misbehaving tool (whether its
 * `register()` throws or a spec fails to mount) must not take the whole CLI
 * down. The failure is logged and stderr-warned, then we continue with the
 * next tool. A tool with NEITHER `commandSpecs` nor `register()` is a
 * mis-declared plugin: logged via `cli.tool.no_command_surface` and skipped.
 */
export function mountAllToolCommands(registry: ToolRegistry, ctx: ToolCliContext): void {
  const program = ctx.program as CliProgram;
  for (const tool of registry.list()) {
    try {
      mountOneTool(program, tool, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: tool ${tool.metadata.id} failed to register: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.register_failed',
        module: BOOTSTRAP_MODULE,
        toolId: tool.metadata.id,
        error: msg,
      });
    }
  }
  // ADR-0021: one shared help shape across every mounted command — uniform
  // option/subcommand ordering and a docs footer — applied here (the single
  // place that has walked every tool's commands) rather than per tool.
  applySharedHelpConfiguration(program);
}

/**
 * Mount ONE tool's commands, choosing the declarative spec path when the tool
 * provides `commandSpecs` and falling back to the deprecated `register()`
 * otherwise. Extracted so {@link mountAllToolCommands} keeps its per-tool
 * failure isolation around a single call.
 */
function mountOneTool(program: CliProgram, tool: Tool, ctx: ToolCliContext): void {
  if (tool.commandSpecs !== undefined && tool.commandSpecs.length > 0) {
    for (const spec of tool.commandSpecs) {
      // `Tool.commandSpecs` is `CommandSpec<unknown, ToolCliContext>[]`, which
      // is assignable to the mounter's `HostCommandSpec` (handler contravariance
      // — an `unknown`-opts handler accepts a `Record`-opts call). No cast.
      mountCommandSpec(program, spec, ctx);
    }
    return;
  }
  // The two `tool.register` reads below ARE the deliberate deprecated-register()
  // fallback consumer (release 2.11.0 Phase 2). register() is sanctioned through
  // 2.x; reading it here is the whole point — the structured
  // `cli.tool.register_deprecated` event drives migration, and fit/graph/sim
  // mount via this path until their Phase 3-5 commandSpecs cutover.
  // eslint-disable-next-line sonarjs/deprecation -- deliberate fallback (see above).
  if (tool.register !== undefined) {
    // Legacy raw-Commander path — sanctioned through 2.x, removed in 3.0.0.
    // Emit a structured deprecation event so adopters (and our own dogfood)
    // can see which tools still mount the old way before the 3.0.0 cutover.
    logger.warn({
      evt: 'cli.tool.register_deprecated',
      module: BOOTSTRAP_MODULE,
      toolId: tool.metadata.id,
      detail: "tool mounts via deprecated register(); prefer commandSpecs (removed in 3.0.0)",
    });
    // eslint-disable-next-line sonarjs/deprecation -- deliberate fallback call (see above).
    tool.register(ctx);
    return;
  }
  // Neither a declarative command surface nor a legacy register() — a
  // mis-declared tool contributes no commands. Surface it rather than
  // silently mounting nothing.
  logger.warn({
    evt: 'cli.tool.no_command_surface',
    module: BOOTSTRAP_MODULE,
    toolId: tool.metadata.id,
    detail: 'tool declares neither commandSpecs nor register(); no commands mounted',
  });
}

const DOCS_HELP_FOOTER = '\nDocs: https://opensip.ai/docs/opensip-tools';

/**
 * Apply one help configuration to the root program and every (sub)command:
 * options + subcommands sort alphabetically so the help reads the same across
 * `fit`/`graph`/`sim`, and the root help ends with a docs pointer (ADR-0021).
 */
function applySharedHelpConfiguration(program: CliProgram): void {
  const configure = (cmd: CliProgram): void => {
    cmd.configureHelp({ sortOptions: true, sortSubcommands: true });
    for (const sub of cmd.commands) configure(sub);
  };
  configure(program);
  program.addHelpText('after', DOCS_HELP_FOOTER);
}
