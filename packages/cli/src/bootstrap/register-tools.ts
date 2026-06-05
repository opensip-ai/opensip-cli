// @fitness-ignore-file performance-anti-patterns -- sequential await across discovered tool packages preserves load order for plugin-conflict detection; bounded by installed plugin count
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

import { pathToFileURL } from 'node:url';

import {
  discoverToolPackagesFromAnchors,
  logger,
  readToolPackageMetadata,
  resolveProjectContext,
  resolveProjectPaths,
  resolveUserPaths,
  type Tool,
  type ToolCliContext,
  type ToolDiscoverySource,
  type ToolRegistry,
} from '@opensip-tools/core';
import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';
import { simulationTool } from '@opensip-tools/simulation';

import { isValidTool } from './validate-tool.js';

/** First-party tools — declared as direct deps of opensip-tools. */
export const FIRST_PARTY_TOOLS: readonly Tool[] = [
  fitnessTool,
  simulationTool,
  graphTool,
];

/** Register first-party tools into the supplied registry. */
export function registerFirstPartyTools(registry: ToolRegistry): void {
  for (const tool of FIRST_PARTY_TOOLS) {
    registry.register(tool);
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
    // No resolvable project context → no project-local tool source.
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
 */
export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
): Promise<void> {
  const builtInIds = new Set(FIRST_PARTY_TOOLS.map((t) => t.metadata.id));
  const discovered = discoverToolPackagesFromAnchors(opts.sources);

  for (const pkg of discovered) {
    try {
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
        logger.warn({ evt: 'cli.tool.no_entry', module: 'cli:bootstrap', name: pkg.name });
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
          module: 'cli:bootstrap',
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
        module: 'cli:bootstrap',
        name: pkg.name,
        error: msg,
      });
    }
  }
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
        module: 'cli:bootstrap',
        toolId: tool.metadata.id,
        error: msg,
      });
    }
  }
}
