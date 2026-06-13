/**
 * `tools list` — the read-only effective-tool inventory (ADR-0041).
 *
 * HARD RULE: this command performs ZERO dynamic imports of tool runtimes. A
 * listing command that executes plugin code is both slow and a consent
 * violation (the trust posture reserves code execution for validate/install).
 * Every row derives from
 *
 *   - the CURRENT RUN's admitted set — the provenance + manifest pairs the
 *     bootstrap recorded, passed in by the command handler from the entered
 *     RunScope (`currentScope().toolProvenance` / `?.toolManifests`),
 *     status `loaded`; and
 *   - marker scans of the two install hosts (user-global + project
 *     `.runtime`), `loadToolManifest` only (a file read), status
 *     `manifest-only` — covering installed-but-not-loaded packages (and, by
 *     construction, a package whose module top-level would throw).
 *
 * Shadow-marking: discovery is first-occurrence-wins (project before global in
 * `buildToolDiscoverySources`), so when a project row and a global row share a
 * tool id the GLOBAL row is marked shadowed.
 */

import { join } from 'node:path';

import {
  discoverPackagesInNodeModules,
  loadToolManifest,
  resolveProjectPaths,
  resolveUserPaths,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';

import { TOOL_DOMAIN } from '../plugin/domain-resolution.js';

import type { ToolsListResult, ToolsListRow } from '@opensip-cli/contracts';

/** The spec's three user-facing source labels. */
type ListSource = ToolsListRow['source'];

/** Options for {@link toolsList}. */
export interface ToolsListOptions {
  readonly cwd: string;
  /** Restrict to one install scope (mutually exclusive; neither = effective set). */
  readonly global?: boolean;
  readonly project?: boolean;
  /**
   * The admitted-tool provenance + manifests for this run (paired index-wise),
   * read by the command handler from the entered RunScope and passed in so this
   * function stays a pure function of its inputs. Default `[]` (no admitted set
   * — e.g. an isolated unit test).
   */
  readonly provenance?: readonly ToolProvenance[];
  readonly manifests?: readonly ToolPluginManifest[];
}

/**
 * Map a loaded tool's provenance to the user-facing source label. Installed
 * tools resolve their scope by which host dir their package landed in
 * (project `.runtime` wins ties — it precedes global in discovery order).
 */
function sourceLabelFor(
  provenance: ToolProvenance,
  projectHostDir: string,
  globalHostDir: string,
): ListSource {
  if (provenance.source === 'bundled') return 'bundled';
  if (provenance.source === 'project-local') return 'project';
  if (provenance.source === 'user-global') return 'global';
  const path = provenance.resolvedPath ?? '';
  if (path.startsWith(projectHostDir)) return 'project';
  if (path.startsWith(globalHostDir)) return 'global';
  // An installed tool discovered via the cwd walk-up or the CLI install dir:
  // it behaves project-wide for this run; label by where it sits relative to
  // the project host, defaulting to global (the broader visibility claim).
  return 'global';
}

/** Build the effective tool inventory. Read-only; never imports a runtime. */
export function toolsList(opts: ToolsListOptions): ToolsListResult {
  const projectHostDir = resolveProjectPaths(opts.cwd).pluginsDir(TOOL_DOMAIN);
  const globalHostDir = resolveUserPaths().pluginsDir(TOOL_DOMAIN);

  const provenance = opts.provenance ?? [];
  const manifests = opts.manifests ?? [];

  const rows: ToolsListRow[] = [];
  const loadedPackageNames = new Set<string>();

  // Loaded set — provenance and manifests are pushed pairwise at admission,
  // so they index together.
  for (const [i, prov] of provenance.entries()) {
    const manifest = manifests[i];
    if (prov.packageName !== undefined) loadedPackageNames.add(prov.packageName);
    rows.push({
      id: prov.id,
      ...(prov.packageName === undefined ? {} : { packageName: prov.packageName }),
      version: prov.version,
      source: sourceLabelFor(prov, projectHostDir, globalHostDir),
      commands: manifest?.commands.map((c) => c.name) ?? [],
      status: 'loaded',
    });
  }

  // Installed-but-not-loaded set — marker scan + manifest file read per host.
  const hosts: readonly { dir: string; source: ListSource }[] = [
    { dir: projectHostDir, source: 'project' },
    { dir: globalHostDir, source: 'global' },
  ];
  for (const host of hosts) {
    for (const pkg of discoverPackagesInNodeModules(join(host.dir, 'node_modules'), 'tool')) {
      if (loadedPackageNames.has(pkg.name)) continue;
      const manifest = loadToolManifest('installed', pkg.packageDir);
      rows.push({
        id: manifest?.id ?? pkg.name,
        packageName: pkg.name,
        version: manifest?.version ?? 'unknown',
        source: host.source,
        commands: manifest?.commands.map((c) => c.name) ?? [],
        status: 'manifest-only',
      });
    }
  }

  // Shadow-marking: a project row shadows a global row with the same tool id
  // (matches discovery's first-occurrence-wins ordering: project precedes
  // global). Bundled rows are never shadow-marked — the registry's
  // first-writer-wins already keeps a duplicate id from loading at all.
  const projectIds = new Set(rows.filter((r) => r.source === 'project').map((r) => r.id));
  const marked: ToolsListRow[] = rows.map((row) =>
    row.source === 'global' && projectIds.has(row.id) ? { ...row, shadowed: true } : row,
  );

  let filtered = marked;
  if (opts.global === true) filtered = marked.filter((r) => r.source === 'global');
  else if (opts.project === true) filtered = marked.filter((r) => r.source === 'project');

  return { type: 'tools-list', tools: filtered, totalCount: filtered.length };
}
