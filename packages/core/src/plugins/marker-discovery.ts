/**
 * @fileoverview Generic marker-based plugin discovery.
 *
 * Walks ancestor `node_modules/` directories from a project root, looking
 * for packages whose `package.json` declares an `opensipTools.kind` value
 * matching the requested kind. Returns the deduplicated list (first
 * occurrence walking outward wins, matching Node's nearest-ancestor
 * module resolution).
 *
 * Three marker kinds are recognised today: `'tool'`, `'fit-pack'`,
 * `'sim-pack'`. New kinds get added to `MarkerKind` explicitly — keeping
 * the union closed lets the type system catch typos at call sites.
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../lib/logger.js';

const MARKER_KINDS = ['tool', 'fit-pack', 'sim-pack'] as const;

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
  const { projectDir, kind } = options;
  const seen = new Set<string>();
  const out: DiscoveredMarkerPackage[] = [];
  let dir = projectDir;
  let prev = '';
  while (dir !== prev) {
    const nodeModules = join(dir, 'node_modules');
    if (existsSync(nodeModules)) {
      collectFromNodeModules(nodeModules, kind, seen, out);
    }
    prev = dir;
    dir = dirname(dir);
  }
  return out;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- node_modules walker: handles both flat and @scope/* layouts and skips invalid entries inline
function collectFromNodeModules(
  nodeModulesDir: string,
  kind: MarkerKind,
  seen: Set<string>,
  out: DiscoveredMarkerPackage[],
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
        if (readMarkerKind(pkgDir) === kind) {
          seen.add(name);
          out.push({ name, packageDir: pkgDir, kind });
        }
      }
      continue;
    }
    if (seen.has(entry)) continue;
    if (readMarkerKind(entryPath) === kind) {
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
 */
function readMarkerKind(packageDir: string): MarkerKind | undefined {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      opensipTools?: { kind?: unknown };
    };
    const kind = pkg.opensipTools?.kind;
    return isMarkerKind(kind) ? kind : undefined;
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

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
