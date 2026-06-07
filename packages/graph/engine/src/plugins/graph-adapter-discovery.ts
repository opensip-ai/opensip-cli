/**
 * @fileoverview Auto-discovery of @opensip-tools/graph-* adapter
 * packages installed in node_modules.
 *
 * Resolution rules (apply in order):
 *
 *   1. If `plugins.graphAdapters` is declared in the project config,
 *      that explicit list wins. Auto-discovery is skipped entirely.
 *      Lets users pin their adapter set deterministically.
 *
 *   2. Else if `plugins.autoDiscoverGraphAdapters: false` is declared,
 *      no adapter packages are loaded via discovery. Lets users opt
 *      out of dependency-based discovery (e.g. when running in an
 *      environment with unrelated @opensip-tools packages installed).
 *
 *   3. Otherwise (default), discover every package that declares
 *      `opensipTools.kind: "graph-adapter"` via the ONE shared marker
 *      substrate (`discoverPackagesByMarker`, core). The marker is the
 *      authoritative gate: shared scaffolding libraries under the same
 *      prefix (e.g. `@opensip-tools/graph-adapter-common`, which carries
 *      no marker) are NOT adapters and never surface. Return the list.
 *
 * Rule 3 used to carry a bespoke ancestor-walk that re-implemented the
 * marker substrate's node_modules traversal plus a redundant
 * `@opensip-tools/graph-*` prefix anchor. The walk is now delegated to
 * `discoverPackagesByMarker({ kind: 'graph-adapter' })`; this file keeps
 * only the graph-domain POLICY (the three-rule resolution + the explicit
 * `plugins.graphAdapters` / `autoDiscoverGraphAdapters` config reads).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  discoverPackagesByMarker,
  logger,
  readYamlFile,
  resolvePackageEntryPoint,
} from '@opensip-tools/core';

const CONFIG_FILENAME = 'opensip-tools.config.yml';

export interface GraphAdapterDiscoveryOptions {
  /** Absolute path to the project root (where opensip-tools.config.yml lives). */
  readonly projectDir: string;
  /** Explicit list from `plugins.graphAdapters` in the config. */
  readonly explicitPackages?: readonly string[];
  /** When false, auto-discovery is disabled. Default: true. */
  readonly autoDiscover?: boolean;
}

export interface DiscoveredGraphAdapterPackage {
  /** npm package name, e.g. '@opensip-tools/graph-typescript'. */
  readonly name: string;
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string;
}

/**
 * Resolve the list of graph-adapter packages to load, applying the
 * ordered resolution rules in the file header. Returns every
 * discovered @opensip-tools/graph-* package; the CLI loads them all
 * uniformly, with no package privileged over another.
 */
export function discoverGraphAdapterPackages(
  options: GraphAdapterDiscoveryOptions,
): DiscoveredGraphAdapterPackage[] {
  const { projectDir, explicitPackages, autoDiscover = true } = options;

  // Rule 1: explicit list wins
  if (explicitPackages !== undefined) {
    if (explicitPackages.length === 0) {
      return [];
    }
    const out: DiscoveredGraphAdapterPackage[] = [];
    for (const name of explicitPackages) {
      const dir = resolvePackageDir(projectDir, name);
      if (dir) {
        out.push({ name, packageDir: dir });
      } else {
        logger.warn({
          evt: 'plugin.graph_adapter.not_resolved',
          module: 'graph:plugins',
          name,
          msg: `Configured graph adapter "${name}" is not installed in node_modules — skipping`,
        });
      }
    }
    return out;
  }

  // Rule 2: opt-out
  if (!autoDiscover) {
    return [];
  }

  // Rule 3: auto-discover via the ONE shared marker substrate
  return autoDiscoverAdapters(projectDir);
}

/**
 * Discover every `opensipTools.kind: "graph-adapter"` package through the
 * shared core marker substrate (`discoverPackagesByMarker`) — the same
 * ancestor-walking node_modules traversal + nearest-ancestor dedup that
 * tool / fit-pack / sim-pack discovery use. This is the thin graph-domain
 * wrapper: it adapts the substrate's `DiscoveredMarkerPackage`
 * (`{ name, packageDir, kind }`) to the graph-local
 * `DiscoveredGraphAdapterPackage` (`{ name, packageDir }`).
 *
 * Scaffolding libraries that share the `graph-` name prefix but carry no
 * marker — e.g. `@opensip-tools/graph-adapter-common` — and the engine
 * itself (`@opensip-tools/graph`) declare no `graph-adapter` kind, so the
 * substrate never returns them. The redundant prefix anchor the prior
 * bespoke walker carried is therefore unnecessary.
 */
function autoDiscoverAdapters(projectDir: string): DiscoveredGraphAdapterPackage[] {
  return discoverPackagesByMarker({ projectDir, kind: 'graph-adapter' }).map(
    ({ name, packageDir }) => ({ name, packageDir }),
  );
}

function resolvePackageDir(projectDir: string, name: string): string | undefined {
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const candidate = join(dir, 'node_modules', name);
    if (hasPackageJson(candidate)) return candidate;
    prev = dir;
    dir = dirname(dir);
  }
  return undefined;
}

function hasPackageJson(packageDir: string): boolean {
  if (!existsSync(packageDir)) return false;
  return existsSync(join(packageDir, 'package.json'));
}

/**
 * Read `name` and `main`/`exports` from a package.json. Used by the CLI
 * to resolve the entry point of a discovered graph adapter package.
 */
export interface GraphAdapterPackageMetadata {
  readonly name: string;
  readonly mainEntry: string;
}

/**
 * Read the `plugins.graphAdapters` and `plugins.autoDiscoverGraphAdapters`
 * fields from the project's opensip-tools.config.yml without doing a
 * full schema parse. Returns the raw values so callers can apply the
 * resolution rules in `discoverGraphAdapterPackages()`.
 *
 * Mirrors the inline-yaml-read pattern used by fitness's
 * `readCheckPackagePreferences()` — avoids a circular dep between
 * plugins/ and any heavier config-parsing module.
 */
export function readGraphAdapterPackagePreferences(projectDir: string): {
  readonly graphAdapters?: readonly string[];
  readonly autoDiscoverGraphAdapters?: boolean;
} {
  const configPath = join(projectDir, CONFIG_FILENAME);
  const doc = readYamlFile(configPath);
  if (!doc || typeof doc !== 'object') return {};
  const plugins = (doc as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== 'object') return {};
  const p = plugins as Record<string, unknown>;
  const result: { graphAdapters?: readonly string[]; autoDiscoverGraphAdapters?: boolean } = {};
  if (Array.isArray(p.graphAdapters)) {
    result.graphAdapters = p.graphAdapters.filter((v): v is string => typeof v === 'string');
  }
  if (typeof p.autoDiscoverGraphAdapters === 'boolean') {
    result.autoDiscoverGraphAdapters = p.autoDiscoverGraphAdapters;
  }
  return result;
}

export function readGraphAdapterPackageMetadata(
  packageDir: string,
): GraphAdapterPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir);
  if (!resolved) return undefined;
  return { name: resolved.name, mainEntry: resolved.entry };
}
