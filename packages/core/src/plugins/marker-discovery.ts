/**
 * @fileoverview Generic marker-based plugin discovery.
 *
 * Walks ancestor `node_modules/` directories from a project root, looking
 * for packages whose `package.json` declares an `opensipTools.kind` value
 * matching the requested kind. Returns the deduplicated list (first
 * occurrence walking outward wins, matching Node's nearest-ancestor
 * module resolution).
 *
 * Four marker kinds are recognised today: `'tool'`, `'fit-pack'`,
 * `'sim-pack'`, and `'graph-adapter'`. New kinds get added to `MarkerKind`
 * explicitly — keeping the union closed lets the type system catch typos at
 * call sites, and makes `MARKER_KINDS` the single source of truth for the
 * plugin-kind vocabulary (the workspace-invariant test asserts every
 * package.json marker against it).
 *
 * Why a marker rather than a name pattern: a name-prefix rule (e.g.
 * anything matching `@opensip-tools/*`) breaks down once organisations
 * publish their own scoped packs (`@my-company/checks-acme`). Marker-
 * based discovery decouples publication scope from plugin shape, so
 * customers can ship under any scope they own.
 *
 * Tool plugins, fit packs, and sim packs all share this walker. The
 * domain-typed wrappers (`tool-package-discovery.ts`,
 * fitness `cli/fit.ts`, simulation `cli/sim.ts`) call this with their
 * respective kinds and adapt the return type.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../lib/logger.js';

import { safeReaddir } from './node-modules-walk.js';

/**
 * The closed vocabulary of `opensipTools.kind` markers. Exported as the
 * single source of truth: discovery wrappers narrow to it, and the
 * workspace-invariant test validates every package.json marker against it.
 */
export const MARKER_KINDS = ['tool', 'fit-pack', 'sim-pack', 'graph-adapter'] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

export interface MarkerDiscoveryOptions {
  /** Absolute path to the project root. */
  readonly projectDir: string;
  /** Which marker kind to discover. */
  readonly kind: MarkerKind;
}

export interface DiscoveredMarkerPackage {
  /** npm package name, e.g. '@opensip-tools/fitness' or '@my-co/fit'. */
  readonly name: string;
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string;
  /** Echoed back so callers consuming multiple kinds can multiplex. */
  readonly kind: MarkerKind;
}

/**
 * Narrow an unknown string to MarkerKind. Used by readMarkerKind below
 * and re-exported for callers that need to validate dynamic input.
 */
export function isMarkerKind(value: unknown): value is MarkerKind {
  return typeof value === 'string' && (MARKER_KINDS as readonly string[]).includes(value);
}

/**
 * Walk up from `projectDir` looking for `node_modules/` directories.
 * For each one, scan top-level entries (and one level into scoped
 * directories like `@opensip-tools/`) for packages declaring
 * `opensipTools.kind === options.kind`. Return the deduplicated list.
 *
 * Same-named packages are returned once — the first occurrence walking
 * from `projectDir` outward wins, matching Node's nearest-ancestor
 * resolution behavior.
 */
export function discoverPackagesByMarker(
  options: MarkerDiscoveryOptions,
): DiscoveredMarkerPackage[] {
  // Typed narrowing wrapper over the raw-string walker: the kind passed in is a
  // MarkerKind, so every result's echoed kind is that same MarkerKind.
  return discoverPackagesByDeclaredKind(options.projectDir, options.kind).map((p) => ({
    name: p.name,
    packageDir: p.packageDir,
    kind: p.kind as MarkerKind,
  }));
}

/**
 * Scan EXACTLY ONE `node_modules` directory for packages declaring
 * `opensipTools.kind === kind` — no ancestor walk. Used for fixed plugin
 * host dirs (`~/.opensip-tools/plugins/tool/node_modules`,
 * `<project>/.runtime/plugins/tool/node_modules`) where walking up would
 * wrongly pull in `$HOME/node_modules` or unrelated ancestor trees.
 */
export function discoverPackagesInNodeModules(
  nodeModulesDir: string,
  kind: MarkerKind,
): DiscoveredMarkerPackage[] {
  const out: DiscoveredDeclaredPackage[] = [];
  if (existsSync(nodeModulesDir)) {
    collectByDeclaredKind(nodeModulesDir, kind, new Set<string>(), out);
  }
  return out.map((p) => ({ name: p.name, packageDir: p.packageDir, kind: p.kind as MarkerKind }));
}

/**
 * A package discovered by its declared `opensipTools.kind`, with the kind as a
 * raw string (NOT narrowed to the closed `MarkerKind` union). This is the shape
 * the generic capability-discovery substrate consumes — a domain's marker kind
 * comes from its manifest descriptor, so it cannot be a compile-time union member.
 */
export interface DiscoveredDeclaredPackage {
  readonly name: string;
  readonly packageDir: string;
  readonly kind: string;
}

/**
 * Walk ancestor `node_modules/` directories from `projectDir`, returning every
 * package whose `package.json` declares `opensipTools.kind === kind` for the
 * given raw-string kind. The string-typed generalization of
 * {@link discoverPackagesByMarker}: the closed-union version is a thin wrapper
 * over this. Deduplicated; first occurrence walking outward wins.
 */
export function discoverPackagesByDeclaredKind(
  projectDir: string,
  kind: string,
): DiscoveredDeclaredPackage[] {
  const seen = new Set<string>();
  const out: DiscoveredDeclaredPackage[] = [];
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const nodeModules = join(dir, 'node_modules');
    if (existsSync(nodeModules)) {
      collectByDeclaredKind(nodeModules, kind, seen, out);
    }
    prev = dir;
    dir = dirname(dir);
  }
  return out;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- node_modules walker: handles both flat and @scope/* layouts and skips invalid entries inline
function collectByDeclaredKind(
  nodeModulesDir: string,
  kind: string,
  seen: Set<string>,
  out: DiscoveredDeclaredPackage[],
): void {
  for (const entry of safeReaddir(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    const entryPath = join(nodeModulesDir, entry);
    if (entry.startsWith('@')) {
      // Scoped — descend one level
      for (const scopedEntry of safeReaddir(entryPath)) {
        if (scopedEntry.startsWith('.')) continue;
        const name = `${entry}/${scopedEntry}`;
        if (seen.has(name)) continue;
        const pkgDir = join(entryPath, scopedEntry);
        if (readDeclaredKind(pkgDir) === kind) {
          seen.add(name);
          out.push({ name, packageDir: pkgDir, kind });
        }
      }
      continue;
    }
    if (seen.has(entry)) continue;
    if (readDeclaredKind(entryPath) === kind) {
      seen.add(entry);
      out.push({ name: entry, packageDir: entryPath, kind });
    }
  }
}

/**
 * Read the declared `opensipTools.kind` from a package's package.json.
 * Returns the kind if it parses, is a string, and matches the closed
 * MarkerKind union; otherwise undefined. Parse failures are logged at
 * debug — a malformed package.json under node_modules is not a discovery
 * concern, just an entry to skip.
 *
 * Exported as the canonical marker reader: every discovery path (tool,
 * fit-pack, sim-pack, graph-adapter) reads the marker through this one
 * function, so there is no second implementation to drift.
 */
export function readMarkerKind(packageDir: string): MarkerKind | undefined {
  const kind = readDeclaredKind(packageDir);
  return isMarkerKind(kind) ? kind : undefined;
}

/**
 * Read the RAW `opensipTools.kind` string from a package's package.json — the
 * string-typed sibling of {@link readMarkerKind}, with no closed-union narrowing.
 * Returns the string if it parses and is a string; otherwise undefined. Parse
 * failures are logged at debug (a malformed node_modules package.json is an
 * entry to skip, not a discovery error). The generic discovery substrate reads
 * declared kinds through this one function so there is no second implementation
 * to drift.
 */
export function readDeclaredKind(packageDir: string): string | undefined {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      opensipTools?: { kind?: unknown };
    };
    const kind = pkg.opensipTools?.kind;
    return typeof kind === 'string' ? kind : undefined;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug({
      evt: 'core.marker_discovery.read_failed',
      module: 'core:plugins',
      packageDir,
      error: msg,
    });
    return undefined;
  }
}
