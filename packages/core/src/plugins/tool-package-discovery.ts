/**
 * @fileoverview Thin domain-typed wrapper around the generic marker
 * walker for `kind: "tool"`.
 *
 * A Tool plugin is any npm package (scoped or unscoped, first- or third-
 * party) whose `package.json` declares:
 *
 *   {
 *     "opensipTools": {
 *       "kind": "tool",
 *       "id": "audit-sec",
 *       "identity": { "name": "audit-sec" },
 *       "apiVersion": 1,
 *       "commands": [{ "name": "audit-sec", "description": "Run the audit" }]
 *     }
 *   }
 *
 * The walker itself lives in `marker-discovery.ts` — this file preserves
 * the public surface (`discoverToolPackages`, `DiscoveredToolPackage`)
 * existing CLI consumers depend on, and delegates the actual node_modules
 * traversal to the shared primitive.
 *
 * Direct dependencies of opensip-cli are always loaded by the
 * CLI's own import statements; this discovery exists so a user can
 * install a third-party tool via `npm install` and have it picked up
 * with no further wiring.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isRecord } from './json-guards.js';
import { PROJECT_LOCAL_MANIFEST_FILE } from './manifest-loader.js';
import { discoverPackagesByMarker, discoverPackagesInNodeModules } from './marker-discovery.js';
import { resolvePackageEntryPoint } from './package-entry.js';

export interface ToolPackageDiscoveryOptions {
  /** Absolute path to the project root. */
  readonly projectDir: string;
}

export interface DiscoveredToolPackage {
  /** npm package name, e.g. '@opensip-cli/fitness' or '@my-co/audit'. */
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
  return discoverPackagesByMarker({ projectDir: options.projectDir, kind: 'tool' }).map((pkg) => ({
    name: pkg.name,
    packageDir: pkg.packageDir,
  }));
}

/**
 * One discovery source for {@link discoverToolPackagesFromAnchors}.
 *
 *  - `walkUp`: walk ancestor `node_modules` from `dir` (project trees, the
 *    CLI install dir — covers a plain `npm install @tool` and global CLI
 *    siblings).
 *  - `scanDir`: scan exactly `<dir>/node_modules`, no walk (the fixed
 *    plugin host dirs — `~/.opensip-cli/plugins/tool`,
 *    `<project>/.runtime/plugins/tool`).
 */
export interface ToolDiscoverySource {
  readonly dir: string;
  readonly mode: 'walkUp' | 'scanDir';
}

/**
 * Discover tool packages across an ORDERED list of sources, deduplicated
 * by package name with first-occurrence-wins. Order encodes precedence:
 * an earlier source's package shadows a later same-named one (e.g. a
 * project-local pin shadows a user-global install). Mirrors the
 * ToolRegistry's own first-writer-wins on duplicate ids.
 *
 * **Provenance contract.** Every anchor yields `source: 'installed'`
 * provenance regardless of which anchor it came from — the anchor distinction
 * encodes PRECEDENCE/SHADOWING, NOT source. So the caller
 * (`admitInstalledTool` in `register-tools.ts`) assigns `source: 'installed'`
 * UNIFORMLY; a per-anchor source tag here would add no information and is
 * deliberately NOT threaded. *Authored* provenance (`project-local` /
 * `user-global`) comes from the separate `discoverAuthoredToolSidecars` walk,
 * keyed by its calling root — not from this npm-anchor walk.
 *
 * Scope flag: if a future release adds a third installed sub-source that needs
 * distinct provenance, revisit whether the anchors walk should carry a source
 * enum. Out of scope today.
 */
export function discoverToolPackagesFromAnchors(
  sources: readonly ToolDiscoverySource[],
): DiscoveredToolPackage[] {
  const seen = new Set<string>();
  const out: DiscoveredToolPackage[] = [];
  for (const src of sources) {
    const found =
      src.mode === 'walkUp'
        ? discoverPackagesByMarker({ projectDir: src.dir, kind: 'tool' })
        : discoverPackagesInNodeModules(join(src.dir, 'node_modules'), 'tool');
    for (const pkg of found) {
      if (seen.has(pkg.name)) continue;
      seen.add(pkg.name);
      out.push({ name: pkg.name, packageDir: pkg.packageDir });
    }
  }
  return out;
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

/**
 * Resolve a tool directory's runtime entry.
 *
 * An INSTALLED npm tool resolves via `package.json` (`exports['.']` → `main` →
 * `./index.js`). An AUTHORED tool has no `package.json` — it declares identity
 * via an `opensip-tool.manifest.json` sidecar, so when the package.json resolver
 * finds nothing, fall back to the sidecar: its `main` field (or `./index.js`
 * default), with the directory name as the package name. This keeps the two
 * discovery surfaces symmetric — one entry resolver serves both the npm and
 * authored legs.
 */
export function readToolPackageMetadata(packageDir: string): ToolPackageMetadata | undefined {
  const resolved = resolvePackageEntryPoint(packageDir);
  if (resolved) return { name: resolved.name, mainEntry: resolved.entry };
  return readAuthoredSidecarEntry(packageDir);
}

/**
 * Resolve an authored tool's entry from its `opensip-tool.manifest.json`
 * sidecar. Reads the sidecar's `main` (default `./index.js`) and `name`/`id`
 * for the package name. Returns `undefined` when the sidecar is absent or
 * unreadable (the caller treats that as "no resolvable entry").
 */
function readAuthoredSidecarEntry(dir: string): ToolPackageMetadata | undefined {
  const sidecarPath = join(dir, PROJECT_LOCAL_MANIFEST_FILE);
  if (!existsSync(sidecarPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const rawMain =
    typeof parsed.main === 'string' && parsed.main.length > 0 ? parsed.main : './index.js';
  // Name from the sidecar's name/id, falling back to the directory name (always
  // present for a real authored-tool dir).
  const name =
    (typeof parsed.name === 'string' && parsed.name) ||
    (typeof parsed.id === 'string' && parsed.id) ||
    basename(dir);
  return { name, mainEntry: join(dir, rawMain) };
}
