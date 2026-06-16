import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger, PluginIncompatibleError } from '@opensip-cli/core';

/** `module` field on every structured log event emitted from this file. */
export const BOOTSTRAP_MODULE = 'cli:bootstrap';

/** Used to resolve the bundled engine package dirs from the CLI's own module graph. */
const requireFromHere = createRequire(import.meta.url);

/**
 * Bundled first-party tools are now data-driven (platform-ergonomics Workstream A).
 * The source of truth is the co-located JSON manifest (single edit site when
 * adding a first-party tool). Loaded via fs + import.meta.url (works in both
 * src dev and dist/ after tsc; the json is committed under src/ and must be
 * present next to the .js in dist at runtime — ensured by package "files": ["dist"]
 * + manual cp in build or future asset plugin; no resolveJsonModule dep).
 */
const manifestUrl = new URL('bundled-tools.manifest.json', import.meta.url);
const bundledManifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8')) as {
  bundledPackages: readonly string[];
  scaffoldingToolIds: readonly string[];
};

export const BUNDLED_TOOL_PACKAGES: readonly string[] = bundledManifest.bundledPackages;

/**
 * The ADR-0038 back-compat pin: the tool IDS whose `init` scaffold dirs the
 * pre-registry-driven CLI ALWAYS created (fit/sim). The composition root warns
 * (`cli.tool.expected_bundled_absent`) when one of these is missing from the
 * populated registry, so a build whose {@link BUNDLED_TOOL_PACKAGES} drifted
 * (a tool removed, a packaging variant) under-scaffolds LOUDLY instead of
 * silently.
 *
 * Now derived from the same manifest as BUNDLED_TOOL_PACKAGES (Workstream A)
 * so a single edit keeps them in sync. `graph` is correctly absent: it never
 * scaffolded (`pluginLayout` undefined).
 */
export const EXPECTED_SCAFFOLDING_TOOL_IDS: readonly string[] = bundledManifest.scaffoldingToolIds;

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
export function resolveBundledPackageDir(packageName: string): string | undefined {
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
        const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: unknown;
        };
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
 * Resolve a bundled tool package's on-disk directory, requiring success.
 *
 * @throws {PluginIncompatibleError} when the package directory cannot be
 *   resolved on disk (its manifest is unreadable).
 */
export function resolveRequiredBundledPackageDir(packageName: string): string {
  const dir = resolveBundledPackageDir(packageName);
  if (dir !== undefined) return dir;
  throw new PluginIncompatibleError(
    `bundled tool '${packageName}' could not be resolved on disk; its manifest is unreadable`,
    { diagnostic: 'package directory not resolvable' },
  );
}
