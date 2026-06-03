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
 *   3. Otherwise (default), scan node_modules for any package whose
 *      name matches `@opensip-tools/graph-*` (anchored on the hyphen
 *      so the engine itself, `@opensip-tools/graph`, is excluded) AND
 *      that declares `opensipTools.kind: "graph-adapter"` — so shared
 *      scaffolding libraries under the same prefix (e.g.
 *      `@opensip-tools/graph-adapter-common`, which exports no `adapter`)
 *      are not mistaken for adapters. Return the list.
 *
 * Modeled byte-for-byte on
 * `packages/fitness/engine/src/plugins/check-package-discovery.ts`.
 * Three-rule resolution sequence is identical; only the prefix and
 * config keys differ. The walker handles pnpm's nested node_modules
 * layout: it looks at the project's direct node_modules, then walks
 * up to ancestor node_modules (matching Node's resolution algorithm).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger, readYamlFile, resolvePackageEntryPoint } from '@opensip-tools/core';

const CONFIG_FILENAME = 'opensip-tools.config.yml';

const SCOPE = '@opensip-tools';
const ADAPTER_PREFIX = 'graph-';

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

  // Rule 3: auto-discover
  return autoDiscoverAdapters(projectDir);
}

/**
 * Walk up the directory tree from `projectDir` looking for the first
 * `node_modules/@opensip-tools/` directory and return all `graph-*`
 * package directories found there. Mirrors Node's module resolution
 * (any ancestor node_modules counts), which handles pnpm hoisting and
 * monorepo layouts where the scope may live in the workspace root.
 *
 * The hyphen anchor on `graph-` ensures `@opensip-tools/graph` itself
 * (the engine package) does not match — only adapter packs with names
 * like `graph-typescript`, `graph-python`, `graph-rust`.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- ancestor-walk discovery: walks node_modules trees up the directory tree until the filesystem root
function autoDiscoverAdapters(projectDir: string): DiscoveredGraphAdapterPackage[] {
  const seen = new Set<string>();
  const out: DiscoveredGraphAdapterPackage[] = [];
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const scopeDir = join(dir, 'node_modules', SCOPE);
    if (existsSync(scopeDir)) {
      for (const entry of safeReaddir(scopeDir)) {
        if (!entry.startsWith(ADAPTER_PREFIX)) continue;
        // Defense in depth: the prefix is `graph-` (with trailing hyphen),
        // so the bare engine name `graph` cannot match. Belt-and-braces.
        if (entry === 'graph') continue;
        const name = `${SCOPE}/${entry}`;
        if (seen.has(name)) continue;
        const packageDir = join(scopeDir, entry);
        if (!hasPackageJson(packageDir)) continue;
        // Auto-discovery only picks up packages that declare themselves graph
        // adapters (`opensipTools.kind: "graph-adapter"`). Scaffolding libraries
        // that share the `graph-` prefix but carry no marker — e.g.
        // `@opensip-tools/graph-adapter-common` — are NOT adapters and are
        // skipped silently (mirrors tool discovery's `kind === 'tool'` gate;
        // otherwise the CLI warns about their missing `adapter` export).
        if (readPackageKind(packageDir) !== 'graph-adapter') continue;
        seen.add(name);
        out.push({ name, packageDir });
      }
    }
    prev = dir;
    dir = dirname(dir);
  }
  return out;
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
 * Read `opensipTools.kind` from a package's package.json. Returns
 * `undefined` when the file is unreadable, malformed, or carries no kind
 * marker — the signal that a package is NOT a discoverable adapter (only
 * `'graph-adapter'` qualifies for auto-discovery).
 */
function readPackageKind(packageDir: string): string | undefined {
  try {
    const json = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      opensipTools?: { kind?: unknown };
    };
    const kind = json.opensipTools?.kind;
    return typeof kind === 'string' ? kind : undefined;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- unreadable/malformed package.json → treat as "no marker" (not an adapter), same as a genuinely marker-less library.
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- filesystem probe; exception → empty array is the function's contract (missing directory or permission denied returns "no entries", same as a genuinely empty dir).
    return [];
  }
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
