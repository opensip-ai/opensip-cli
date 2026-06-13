// @fitness-ignore-file error-handling-quality -- safeIsDirectory/safeIsFile/isPathInside are filesystem probes where exception → false is the function's contract; missing path or unresolvable realpath legitimately means "not present" / "not inside", not a swallowed error.
/**
 * @fileoverview Plugin discovery for the project-local layout.
 *
 * Discovery is descriptor-driven: the caller passes a `PluginLayout`
 * (`{ domain, userSubdirs }`) declared by the owning tool. The kernel
 * never enumerates tool domains itself (ADR-0009 corollary 1). Two
 * artifact sources are walked for the layout:
 *
 *   1. USER SOURCE — `<project>/opensip-cli/<domain>/<kind>/*.{js,mjs}`
 *      for each `kind` in `layout.userSubdirs` (e.g. `checks`/`recipes`
 *      for fitness, `scenarios`/`recipes` for simulation). Auto-loaded
 *      by directory presence; no config opt-in.
 *
 *   2. NPM PLUGINS — packages installed under
 *      `<project>/opensip-cli/.runtime/plugins/<domain>/node_modules/`
 *      whose names appear in the project's
 *      `opensip-cli.config.yml#plugins.<domain>: [...]`. The explicit
 *      list is required so a `plugin install` step is intentional, not
 *      an accidental load of every transitive devDep.
 *
 * A layout with an empty `userSubdirs` and no declared npm plugins
 * (e.g. the language-adapter domain, whose adapters ship as direct CLI
 * deps) discovers nothing — an emergent property, not a special case.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { resolveProjectConfigPath } from '../config-resolution.js';
import { logger } from '../lib/logger.js';
import { isPathInside, resolveProjectPaths } from '../lib/paths.js';
import { readYamlFile } from '../lib/yaml.js';

import { resolvePackageEntryPoint } from './package-entry.js';

import type { DiscoveredPlugin, PluginLayout } from './types.js';

/** Logger module tag used by every event in this file. */
const MODULE_TAG = 'core:plugins';

// =============================================================================
// PUBLIC ENTRY POINT
// =============================================================================

/**
 * Discover all plugins for a layout in the project layout.
 *
 * Returns a list of `DiscoveredPlugin` entries (loose .mjs files +
 * npm packages) for the loader to import. Discovery is silent on a
 * missing project directory or absent subdirs — callers that care
 * about "did we find anything?" should check the returned length.
 *
 * @param layout      The owning tool's `PluginLayout` (`{ domain,
 *                    userSubdirs }`).
 * @param projectDir  Project root. Required — there is no user-global
 *                    fallback. Pass undefined to discover nothing
 *                    (used by callers that don't have a project
 *                    context yet).
 */
export function discoverPlugins(layout: PluginLayout, projectDir?: string): DiscoveredPlugin[] {
  if (!projectDir) return [];

  const { domain, userSubdirs } = layout;
  const projectPaths = resolveProjectPaths(projectDir);
  const plugins: DiscoveredPlugin[] = [];

  // 1. User-source loose files: opensip-cli/<domain>/<kind>/*.{js,mjs}
  const toolDir = join(projectPaths.userSourceDir, domain);
  for (const kind of userSubdirs) {
    const kindDir = join(toolDir, kind);
    if (!existsSync(kindDir)) continue;
    plugins.push(...discoverLooseFiles(kindDir, `${domain}/${kind}`));
  }

  // 2. Npm-installed plugins under .runtime/plugins/<domain>/.
  //    Only walked when the config explicitly declares
  //    plugins.<domain>: [...]. The runtime dir is gitignored, so
  //    silently auto-loading anything in it would be a recipe for
  //    "where did this check come from?" surprises. Explicit listing
  //    is the contract for npm plugins.
  const declared = readProjectPluginsList(projectDir, domain);
  if (declared && declared.length > 0) {
    const pluginsDir = projectPaths.pluginsDir(domain);
    const nodeModulesDir = join(pluginsDir, 'node_modules');
    if (existsSync(nodeModulesDir)) {
      plugins.push(...discoverNpmPackages(nodeModulesDir, declared));
    }
  }

  logger.info({
    evt: 'plugin.loader.discover',
    module: MODULE_TAG,
    domain,
    packageCount: plugins.filter((p) => p.type === 'package').length,
    fileCount: plugins.filter((p) => p.type === 'file').length,
  });

  return plugins;
}

// =============================================================================
// CONFIG READING (plugins.<domain> from opensip-cli.config.yml)
// =============================================================================

/**
 * Read the declared plugin list for a domain from the project config.
 * Returns undefined when the config is absent, unreadable, or has no
 * entry for the domain. Does NOT throw on YAML parse errors — returns
 * undefined so discovery falls through gracefully and the config-layer
 * schema validation surfaces parse errors on its own path.
 *
 * Config-path resolution mirrors `resolveProjectConfigPath` (the same
 * helper the targets loader uses): --config flag → `package.json#
 * opensip-cli.configPath` pointer → default `<projectDir>/opensip-
 * tools.config.yml`. Without this, projects that locate their config
 * via the package.json pointer have their `plugins.<domain>: [...]`
 * declaration silently ignored — discovery falls through to the empty
 * default path and the plugin pack never registers.
 *
 * The `--config` precedence is honored only when callers pass through
 * their explicit value via `explicitConfigPath`; this entry point is
 * the implicit one (no --config available at the discovery seam), so
 * we resolve without an explicit path and rely on the pointer + default.
 */
export function readProjectPluginsList(
  projectDir: string,
  domain: string,
): readonly string[] | undefined {
  let configPath: string;
  try {
    configPath = resolveProjectConfigPath(projectDir);
  } catch {
    // resolveProjectConfigPath throws on "no config found anywhere" —
    // discovery is implicit (no --config), so a missing config falls
    // through gracefully here (the explicit-path layer surfaces its own
    // error when the caller asked for one).
    return undefined;
  }
  // Parse YAML via the shared permissive helper to avoid a circular dep
  // between plugins/ and targets/. We only need the `plugins.<domain>`
  // array; anything else is validated by the targets loader.
  const doc = readYamlFile(configPath);
  if (!doc || typeof doc !== 'object') return undefined;
  const plugins = (doc as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== 'object') return undefined;
  const list = (plugins as Record<string, unknown>)[domain];
  if (!Array.isArray(list)) return undefined;
  return list.filter((v): v is string => typeof v === 'string');
}

// =============================================================================
// NPM PACKAGE DISCOVERY
// =============================================================================

function discoverNpmPackages(
  nodeModulesDir: string,
  declared: readonly string[],
): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  for (const name of declared) {
    // Reject names that could traverse before they ever touch the filesystem.
    // The plugin list comes from opensip-cli.config.yml — user-controlled
    // content under a project that runs `opensip fit` would otherwise
    // act as an attacker-influenced input flowing into a path join.
    if (name.length === 0 || name.includes('..') || name.startsWith('/') || name.includes('\0')) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'invalid plugin name',
        name,
      });
      continue;
    }
    const packageDir = join(nodeModulesDir, name);
    // Containment check: the resolved real path (after symlinks) must
    // stay inside node_modules. Catches symlink-based escapes if an
    // attacker plants a symlink.
    if (!isPathInside(packageDir, nodeModulesDir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'package path resolves outside node_modules',
        name,
      });
      continue;
    }
    const plugin = tryDiscoverPackage(packageDir, name);
    if (plugin) plugins.push(plugin);
  }

  return plugins;
}

function tryDiscoverPackage(packageDir: string, name: string): DiscoveredPlugin | undefined {
  if (!safeIsDirectory(packageDir)) return undefined;

  const resolved = resolvePackageEntryPoint(packageDir, name);
  if (!resolved) {
    logger.debug({
      evt: 'plugin.loader.discover.skip',
      module: MODULE_TAG,
      reason: 'invalid package.json',
      name,
    });
    return undefined;
  }

  // Containment check: the resolved entry must stay inside `packageDir`
  // after symlink resolution. A malicious or accidentally-malformed
  // `pkg.main` / `pkg.exports` such as `../../escape.js` would otherwise
  // traverse out of node_modules and be dynamically imported. The earlier
  // package-dir containment check (discoverNpmPackages) does not cover
  // the entry-file path, so we re-check it here.
  if (!isPathInside(resolved.entry, packageDir)) {
    logger.warn({
      evt: 'plugin.loader.discover.reject',
      module: MODULE_TAG,
      reason: 'entry point resolves outside package directory',
      name,
      entry: resolved.entry,
    });
    return undefined;
  }

  if (!existsSync(resolved.entry)) {
    logger.debug({
      evt: 'plugin.loader.discover.skip',
      module: MODULE_TAG,
      reason: 'entry point not found',
      packageName: resolved.name,
      entryPoint: resolved.entry,
    });
    return undefined;
  }

  return {
    type: 'package',
    entryPoint: resolved.entry,
    namespace: resolved.name,
    source: resolved.name,
  };
}

// =============================================================================
// LOOSE FILE DISCOVERY
// =============================================================================

const LOOSE_FILE_EXTENSIONS = new Set(['.js', '.mjs']);

function discoverLooseFiles(dir: string, namespacePrefix: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return plugins;
  }

  for (const entry of entries) {
    const ext = extname(entry);
    if (!LOOSE_FILE_EXTENSIONS.has(ext)) continue;

    const fullPath = join(dir, entry);
    if (!safeIsFile(fullPath)) continue;

    // Containment check: a symlink in the plugin dir pointing outside
    // it would otherwise be dynamically imported, executing arbitrary
    // code from wherever the symlink leads. statSync follows symlinks
    // (intentionally — pnpm uses symlinks inside node_modules for
    // legitimate reasons), so we verify the real path stays inside
    // the plugin dir.
    if (!isPathInside(fullPath, dir)) {
      logger.warn({
        evt: 'plugin.loader.discover.reject',
        module: MODULE_TAG,
        reason: 'loose file resolves outside plugin dir',
        entry,
      });
      continue;
    }

    const baseName = basename(entry, ext);

    plugins.push({
      type: 'file',
      entryPoint: fullPath,
      namespace: `${namespacePrefix}/${baseName}`,
      source: entry,
    });
  }

  return plugins;
}

// =============================================================================
// HELPERS
// =============================================================================

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// isPathInside is centralized in core (lib/paths) for reuse by targeting etc.
