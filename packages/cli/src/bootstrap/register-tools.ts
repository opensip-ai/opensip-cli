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
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-tools/core';
import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';
import { simulationTool } from '@opensip-tools/simulation';

import { isProjectLocalToolTrusted } from './tool-trust.js';
import { isValidTool } from './validate-tool.js';

/** `module` field on every structured log event emitted from this file. */
const BOOTSTRAP_MODULE = 'cli:bootstrap';

/**
 * A first-party tool plus the npm package name that ships its
 * `package.json#opensipTools` manifest. The package name is how the
 * bundled path resolves the tool's own package directory (the dir whose
 * package.json carries the manifest) so it can run the SAME admission gate
 * the external path uses — see {@link resolveBundledPackageDir}.
 */
interface FirstPartyToolEntry {
  readonly tool: Tool;
  readonly packageName: string;
}

/**
 * First-party tools — declared as direct deps of opensip-tools — paired
 * with the package that declares their manifest. Order is registration
 * order (and thus help/listing order).
 */
const FIRST_PARTY_TOOL_ENTRIES: readonly FirstPartyToolEntry[] = [
  { tool: fitnessTool, packageName: '@opensip-tools/fitness' },
  { tool: simulationTool, packageName: '@opensip-tools/simulation' },
  { tool: graphTool, packageName: '@opensip-tools/graph' },
];

/** First-party tools — declared as direct deps of opensip-tools. */
export const FIRST_PARTY_TOOLS: readonly Tool[] = FIRST_PARTY_TOOL_ENTRIES.map(
  (e) => e.tool,
);

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
 * Register first-party tools into the supplied registry, running each one
 * through the SAME `admitTool` gate the external path uses (release 2.8.0,
 * Phase 3). This is ADDITIVE — the direct `registry.register(tool)` still
 * runs for every admitted tool; the gate runs alongside it.
 *
 * Per tool: resolve its package dir, `loadToolManifest('bundled', dir)`, and
 * `admitTool({ source: 'bundled', explicitlyRequested: true })`. A bundled
 * tool is always explicitly shipped, so an out-of-range manifest is a
 * fail-closed (never a silent skip). On `admit` we register the tool (and,
 * defensively, assert the manifest matches the runtime tool to catch drift),
 * then push the recorded `ToolProvenance` onto the optional `provenance`
 * collector so Phase 4's `plugin list` can surface source/identity/hash.
 *
 * @param registry The per-invocation tool registry to populate.
 * @param provenance Optional sink for the admitted tools' provenance records
 *   (defaults to a throwaway array; the bootstrap passes a real collector).
 * @throws {PluginIncompatibleError} when a bundled tool's manifest is missing
 *   or out of range — mapped to `EXIT_CODES.PLUGIN_INCOMPATIBLE` (exit 5) by
 *   the CLI error boundary.
 */
export function registerFirstPartyTools(
  registry: ToolRegistry,
  provenance: ToolProvenance[] = [],
): void {
  for (const { tool, packageName } of FIRST_PARTY_TOOL_ENTRIES) {
    const dir = resolveBundledPackageDir(packageName);
    if (dir === undefined) {
      throw new PluginIncompatibleError(
        `bundled tool '${packageName}' could not be resolved on disk; its manifest is unreadable`,
        { diagnostic: 'package directory not resolvable' },
      );
    }

    const manifest = loadToolManifest('bundled', dir);
    if (manifest === undefined) {
      // A bundled tool MUST ship a conformant manifest (the Phase-5
      // tool-has-manifest guardrail backstops this at CI; at runtime a
      // missing manifest is fail-closed, not a silent skip).
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

    // Defensive drift guard: the static manifest and the runtime tool are two
    // declarations of the same identity (Phase 1). Catch a manifest that fell
    // out of sync with the tool's command surface before it confuses users.
    assertManifestMatchesTool(manifest, tool);

    registry.register(tool);
    provenance.push(result.provenance);
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
export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
  provenance: ToolProvenance[] = [],
): Promise<void> {
  const builtInIds = new Set(FIRST_PARTY_TOOLS.map((t) => t.metadata.id));
  const discovered = discoverToolPackagesFromAnchors(opts.sources);

  for (const pkg of discovered) {
    try {
      // Compatibility gate BEFORE import (release 2.8.0). `'reject'` means the
      // gate skipped it (or it's a built-in id); `'proceed'` means import +
      // register as before (manifest absent → grace window, or admitted).
      if (admitInstalledTool(pkg, builtInIds, provenance) === 'reject') continue;

      // Import by the package's RESOLVED entry path, not its bare name.
      // A discovered tool may live in a host dir (the user-global
      // `~/.opensip-tools/plugins/tool` or the project `.runtime/plugins/tool`)
      // that is NOT on the CLI's own module-resolution path, so `import(name)`
      // would throw MODULE_NOT_FOUND. Resolving the entry from `packageDir`
      // (as the fitness check-loader does) loads it regardless of location.
      const meta = readToolPackageMetadata(pkg.packageDir);
      if (!meta) {
        process.stderr.write(
          `opensip-tools: tool package ${pkg.name} has no resolvable entry point — skipping\n`,
        );
        logger.warn({ evt: 'cli.tool.no_entry', module: BOOTSTRAP_MODULE, name: pkg.name });
        continue;
      }
      const mod = (await import(pathToFileURL(meta.mainEntry).href)) as { tool?: unknown };
      // Runtime shape validation: a third-party tool is an untrusted
      // boundary. Validate the exported `tool` symbol's shape before
      // touching it, matching the pattern used by
      // `register-graph-adapters.ts`. A malformed package gets a clear
      // stderr line + structured warning and is skipped — better than
      // a TypeError mid-registration or a silently-broken Tool slot.
      if (!isValidTool(mod.tool)) {
        process.stderr.write(
          `opensip-tools: tool package ${pkg.name} does not export a valid \`tool\` — skipping\n`,
        );
        logger.warn({
          evt: 'cli.tool.invalid_shape',
          module: BOOTSTRAP_MODULE,
          name: pkg.name,
        });
        continue;
      }
      if (builtInIds.has(mod.tool.metadata.id)) continue;
      registry.register(mod.tool, { sourcePackage: pkg.name });
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
 * Walk the registry and ask each tool to mount its Commander
 * subcommands via `tool.register(cli)`. Failures are isolated so one
 * misbehaving tool doesn't take the whole CLI down — the failure is
 * logged and stderr-warned, then we continue.
 */
export function mountAllToolCommands(registry: ToolRegistry, ctx: ToolCliContext): void {
  for (const tool of registry.list()) {
    try {
      tool.register(ctx);
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
  applySharedHelpConfiguration(ctx.program as CliProgram);
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
