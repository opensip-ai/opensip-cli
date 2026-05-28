/**
 * register-graph-adapters — discover every @opensip-tools/graph-*
 * adapter pack found in node_modules and stash the loaded adapter
 * objects so the graph tool's `extendScope` hook can register them
 * into each per-run RunScope.
 *
 * History: before Item 1 this file registered adapters directly into a
 * process-level registry. With per-RunScope adapter registries, that
 * registration would target a scope that doesn't exist yet at CLI
 * startup. Instead, we collect the discovered adapters into a single
 * list and hand it to the graph engine via `setDiscoveredAdapters`;
 * `graphTool.extendScope` reads that list and re-registers each
 * adapter into the new scope's fresh adapter registry on every CLI
 * invocation.
 *
 * Failures (missing export, bad shape, import throw) follow the same
 * isolated-failure pattern register-tools.ts uses for tool packages:
 * log `cli.graph_adapter.load_failed`, write a stderr line, continue.
 */

import { pathToFileURL } from 'node:url';

import { logger } from '@opensip-tools/core';
import {
  discoverGraphAdapterPackages,
  readGraphAdapterPackageMetadata,
  readGraphAdapterPackagePreferences,
  setDiscoveredAdapters,
  type GraphLanguageAdapter,
} from '@opensip-tools/graph';

export interface GraphAdapterDiscoveryOptions {
  /** Project directory used to seed `node_modules` walks. */
  readonly projectDir: string;
}

/**
 * Discover and register every graph-adapter pack found via the
 * project's plugin preferences and node_modules walk. Returns the
 * number of adapter packs successfully registered, so callers can
 * surface a meaningful diagnostic if zero packs loaded.
 */
export async function discoverAndRegisterGraphAdapterPackages(
  opts: GraphAdapterDiscoveryOptions,
): Promise<number> {
  const prefs = readGraphAdapterPackagePreferences(opts.projectDir);
  const discovered = discoverGraphAdapterPackages({
    projectDir: opts.projectDir,
    explicitPackages: prefs.graphAdapters,
    autoDiscover: prefs.autoDiscoverGraphAdapters,
  });

  const loaded: GraphLanguageAdapter[] = [];
  for (const pkg of discovered) {
    const meta = readGraphAdapterPackageMetadata(pkg.packageDir);
    if (!meta) {
      process.stderr.write(
        `opensip-tools: graph adapter ${pkg.name} has no readable package.json — skipping\n`,
      );
      continue;
    }
    try {
      const moduleUrl = pathToFileURL(meta.mainEntry).href;
      const mod = (await import(moduleUrl)) as { adapter?: GraphLanguageAdapter };
      if (!mod.adapter || typeof mod.adapter.id !== 'string') {
        process.stderr.write(
          `opensip-tools: graph adapter ${pkg.name} does not export a valid "adapter" — skipping\n`,
        );
        continue;
      }
      loaded.push(mod.adapter);
      logger.info({
        evt: 'cli.graph_adapter.loaded',
        module: 'cli:bootstrap',
        name: pkg.name,
        adapterId: mod.adapter.id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `opensip-tools: failed to load graph adapter ${pkg.name}: ${msg}\n`,
      );
      logger.warn({
        evt: 'cli.graph_adapter.load_failed',
        module: 'cli:bootstrap',
        name: pkg.name,
        error: msg,
      });
    }
  }
  // Stash the loaded set on the graph engine's discovered-adapters
  // holder. graphTool.extendScope reads this list and re-registers
  // each entry into every new RunScope's adapter registry on each CLI
  // invocation. Item 1: the registry is per-scope, not per-process.
  setDiscoveredAdapters(loaded);
  return loaded.length;
}
