/**
 * register-graph-adapters — discover and register every
 * @opensip-tools/graph-* adapter pack found in node_modules.
 *
 * Mirrors the fitness check-pack flow: the CLI is the single
 * registration site, discovery uses an ancestor-walking node_modules
 * scan, and each loaded pack contributes its `adapter` export to the
 * graph engine's lang-adapter registry via `registerAdapter`.
 *
 * Lands in PR 1a of plan
 * docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
 * At PR 1a no graph-* packs exist yet — the three first-party adapters
 * still register through the engine's bootstrap.ts static-import path.
 * The discovery hook is wired in now so PR 1b's relocation of
 * lang-typescript can flip the load-bearing switch in a single move.
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
  registerAdapter,
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

  let registered = 0;
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
      registerAdapter(mod.adapter);
      registered++;
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
  return registered;
}
