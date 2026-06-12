/**
 * `tools uninstall` — scope-aware, identity-resolving removal (ADR-0041).
 *
 * Accepts a tool id OR a package name; resolves it against manifest scans of
 * the two install hosts (file reads only — no runtime import), displays the
 * resolved identity, and removes the package install state. Rules (spec):
 * one uninstallable scope → plain uninstall works; both scopes → require
 * `--global`/`--project`; bundled ids are rejected; SQLite data is never
 * touched here (`tools data purge` owns that).
 */

import { join } from 'node:path';

import {
  discoverPackagesInNodeModules,
  loadToolManifest,
  resolveProjectPaths,
  resolveUserPaths,
} from '@opensip-tools/core';

import { getToolProvenanceForRun } from '../../cli-context.js';
import { TOOL_DOMAIN } from '../plugin/domain-resolution.js';
import { removeToolPlugin } from '../plugin-host-ops.js';

import type { ToolsUninstallResult } from '@opensip-tools/contracts';

/** Options for {@link toolsUninstall}. */
export interface ToolsUninstallOptions {
  /** Tool id or npm package name. */
  readonly target: string;
  readonly cwd: string;
  readonly global?: boolean;
  readonly project?: boolean;
}

interface InstalledCandidate {
  readonly id: string;
  readonly packageName: string;
  readonly scope: 'global' | 'project';
}

/** Manifest-scan both install hosts for removable candidates (no imports). */
function scanInstalledCandidates(cwd: string): InstalledCandidate[] {
  const hosts: readonly { dir: string; scope: InstalledCandidate['scope'] }[] = [
    { dir: resolveProjectPaths(cwd).pluginsDir(TOOL_DOMAIN), scope: 'project' },
    { dir: resolveUserPaths().pluginsDir(TOOL_DOMAIN), scope: 'global' },
  ];
  const candidates: InstalledCandidate[] = [];
  for (const host of hosts) {
    for (const pkg of discoverPackagesInNodeModules(join(host.dir, 'node_modules'), 'tool')) {
      const manifest = loadToolManifest('installed', pkg.packageDir);
      candidates.push({ id: manifest?.id ?? pkg.name, packageName: pkg.name, scope: host.scope });
    }
  }
  return candidates;
}

function failed(target: string, error: string): ToolsUninstallResult {
  return { type: 'tools-uninstall', target, success: false, error };
}

/** Resolve + remove one installed tool. Never touches the datastore. */
export function toolsUninstall(opts: ToolsUninstallOptions): ToolsUninstallResult {
  // Bundled tools are not uninstallable — resolve the bundled id set from the
  // run's provenance (always present: bundled admission is fail-closed).
  const bundledIds = new Set(
    getToolProvenanceForRun()
      .filter((p) => p.source === 'bundled')
      .map((p) => p.id),
  );
  if (bundledIds.has(opts.target)) {
    return failed(
      opts.target,
      `'${opts.target}' is a bundled tool — it ships with the CLI and cannot be uninstalled`,
    );
  }

  const matches = scanInstalledCandidates(opts.cwd).filter(
    (c) => c.id === opts.target || c.packageName === opts.target,
  );
  if (matches.length === 0) {
    return failed(
      opts.target,
      `no installed tool matches '${opts.target}' (by id or package name)`,
    );
  }

  const distinctIds = new Set(matches.map((c) => c.id));
  if (distinctIds.size > 1) {
    const listing = matches.map((c) => `${c.id} (${c.packageName}, ${c.scope})`).join('; ');
    return failed(opts.target, `'${opts.target}' is ambiguous across different tools: ${listing}`);
  }

  const scopes = new Set(matches.map((c) => c.scope));
  let chosen: InstalledCandidate | undefined;
  if (opts.global === true || opts.project === true) {
    const want: InstalledCandidate['scope'] = opts.global === true ? 'global' : 'project';
    chosen = matches.find((c) => c.scope === want);
    if (chosen === undefined) {
      return failed(opts.target, `'${opts.target}' is not installed in the ${want} scope`);
    }
  } else if (scopes.size > 1) {
    return failed(
      opts.target,
      `'${opts.target}' is installed in BOTH scopes — pass --global or --project to choose`,
    );
  } else {
    chosen = matches[0];
  }

  const removal = removeToolPlugin(chosen.packageName, opts.cwd, chosen.scope === 'project');
  if (removal.type !== 'plugin-remove' || removal.success !== true) {
    const error = 'error' in removal ? (removal.error ?? 'removal failed') : 'removal failed';
    return failed(opts.target, error);
  }
  return {
    type: 'tools-uninstall',
    target: opts.target,
    success: true,
    removed: { id: chosen.id, packageName: chosen.packageName, scope: chosen.scope },
  };
}
