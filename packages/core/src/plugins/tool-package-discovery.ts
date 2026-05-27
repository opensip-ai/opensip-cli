/**
 * @fileoverview Thin domain-typed wrapper around the generic marker
 * walker for `kind: "tool"`.
 *
 * A Tool plugin is any npm package (scoped or unscoped, first- or third-
 * party) whose `package.json` declares:
 *
 *   { "opensipTools": { "kind": "tool" } }
 *
 * The walker itself lives in `marker-discovery.ts` — this file preserves
 * the public surface (`discoverToolPackages`, `DiscoveredToolPackage`)
 * existing CLI consumers depend on, and delegates the actual node_modules
 * traversal to the shared primitive.
 *
 * Direct dependencies of @opensip-tools/cli are always loaded by the
 * CLI's own import statements; this discovery exists so a user can
 * install a third-party tool via `npm install` and have it picked up
 * with no further wiring.
 */

import { discoverPackagesByMarker } from './marker-discovery.js';
import { resolvePackageEntryPoint } from './package-entry.js';

export interface ToolPackageDiscoveryOptions {
  /** Absolute path to the project root. */
  readonly projectDir: string;
}

export interface DiscoveredToolPackage {
  /** npm package name, e.g. '@opensip-tools/fitness' or '@my-co/audit'. */
  readonly name: string;
  /** Absolute path to the package's directory inside node_modules. */
  readonly packageDir: string;
}

/**
 * Walk up from `projectDir` looking for `node_modules/` directories
 * containing packages with `opensipTools.kind === 'tool'`. Returns the
 * deduplicated list (first-occurrence-wins by package name).
 */
export function discoverToolPackages(
  options: ToolPackageDiscoveryOptions,
): DiscoveredToolPackage[] {
  return discoverPackagesByMarker({ projectDir: options.projectDir, kind: 'tool' })
    .map((pkg) => ({ name: pkg.name, packageDir: pkg.packageDir }));
}

/**
 * Read `name` and the resolved main entry of a discovered tool package.
 * Mirrors readCheckPackageMetadata in shape but is exposed at the kernel
 * level so any consumer (CLI, tests, future tooling) can resolve a tool
 * package without depending on fitness.
 */
export interface ToolPackageMetadata {
  readonly name: string;
  readonly mainEntry: string;
}

export function readToolPackageMetadata(packageDir: string): ToolPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir);
  if (!resolved) return undefined;
  return { name: resolved.name, mainEntry: resolved.entry };
}
