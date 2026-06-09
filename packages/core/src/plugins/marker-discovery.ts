/**
 * @fileoverview Generic marker-based plugin discovery.
 *
 * Walks ancestor `node_modules/` directories from a project root, looking
 * for packages whose `package.json` declares an `opensipTools.kind` value
 * matching the requested kind. Returns the deduplicated list (first
 * occurrence walking outward wins, matching Node's nearest-ancestor
 * module resolution).
 *
 * `MarkerKind` is the closed union of HOST marker kinds — just `'tool'` now
 * (whole-subcommand Tool plugins, a host concern). The former DOMAIN markers
 * (`'fit-pack'`, `'sim-pack'`, `'graph-adapter'`) were RETIRED from this union
 * once discovery became descriptor-driven (§5.3): a tool's manifest declares its
 * own marker kind, the generic substrate discovers it via the string-typed
 * {@link discoverPackagesByDeclaredKind}, and nothing in the host compiles in the
 * domain vocabulary. Use {@link readDeclaredKind} for any kind that is not the
 * host `'tool'` marker.
 *
 * Why a marker rather than a name pattern (for `'tool'`): a name-prefix rule
 * breaks down once organisations publish their own scoped tool packages. The
 * marker decouples publication scope from plugin shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../lib/logger.js';

import { safeReaddir } from './node-modules-walk.js';

/**
 * The closed vocabulary of HOST `opensipTools.kind` markers — `'tool'` only.
 * Domain markers (fit-pack/sim-pack/graph-adapter) are NOT here anymore: they are
 * declared per-tool in manifests and discovered via {@link discoverPackagesByDeclaredKind}
 * (§5.3). The workspace-invariant test validates a package.json marker against
 * `'tool'` PLUS the marker kinds the bundled manifests declare — descriptor-driven,
 * not a compiled-in domain list.
 */
export const MARKER_KINDS = ['tool'] as const;

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
