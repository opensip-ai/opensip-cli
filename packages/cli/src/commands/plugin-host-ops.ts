/**
 * plugin-host-ops — host-mutation helpers for the `plugin` command.
 *
 * The npm install/uninstall primitives and the Tool-plugin add/remove
 * wrappers that mutate a plugin host dir. Extracted from `plugin.ts` so the
 * command bodies (`pluginList`/`pluginAdd`/`pluginRemove`/`pluginSync`) stay
 * focused on argument validation and config wiring; this module owns the
 * side-effecting npm + host-dir mutation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProjectPaths, resolveUserPaths } from '@opensip-cli/core';

import { TOOL_DOMAIN } from './plugin/domain-resolution.js';
import {
  ensurePluginHostDir,
  ensureUserPluginHostDir,
  findInstalledName,
  HOST_PACKAGE_JSON,
  installMissingPeers,
  readHostDependencies,
} from './plugin/host-dir.js';

import type { PluginResult } from '@opensip-cli/contracts';

// Re-exported so the test hook (`__test.editPluginList`) and any host-ops
// consumer have a single import home for the host-mutation surface.
export { editPluginList } from './plugin/config-edit.js';

/**
 * CommandResult discriminator literals. `as const` keeps the literal type
 * (so the PluginResult union still narrows) while satisfying
 * sonarjs/no-duplicate-string — no scattered eslint-disable needed.
 */
const PLUGIN_ADD = 'plugin-add' as const;
const PLUGIN_REMOVE = 'plugin-remove' as const;

/** Outcome of an npm install into a host dir: the resolved installed name, or an error message. */
export type InstallOutcome =
  | { readonly ok: true; readonly installedName: string }
  | { readonly ok: false; readonly error: string };

/**
 * `npm install --ignore-scripts <spec>` into a plugin host dir, then
 * resolve the real installed name and auto-install peers. Shared by the
 * fit/sim domain path and the Tool-plugin path.
 *
 * --ignore-scripts: plugins run via dynamic import() at tool time; they
 * don't legitimately need install-time code execution. Blocks supply-chain
 * attacks via postinstall hooks. npm's stdout is routed to stderr so JSON
 * renderers (which own process stdout) are not contaminated.
 */
export function npmInstallIntoHost(dir: string, packageName: string): InstallOutcome {
  const depsBefore = readHostDependencies(dir);
  try {
    execFileSync('npm', ['install', '--ignore-scripts', packageName], {
      cwd: dir,
      stdio: ['ignore', process.stderr, process.stderr],
    });
    const resolvedName = findInstalledName(dir, packageName, depsBefore);
    const isLocalPathSpec =
      packageName.startsWith('/') || packageName.startsWith('.') || packageName.startsWith('file:');
    if (!resolvedName && isLocalPathSpec) {
      return {
        ok: false,
        error: `Installed '${packageName}' but could not resolve the installed package name from package.json. The install was not recorded; remove and retry.`,
      };
    }
    installMissingPeers(dir, packageName, depsBefore);
    return { ok: true, installedName: resolvedName ?? packageName };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to add ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Install a Tool plugin into its host dir (user-global by default,
 * project-local with `--project`). No `plugins.<domain>` config entry —
 * Tool plugins auto-discover by their `kind: "tool"` marker.
 */
export function addToolPlugin(packageName: string, cwd: string, project: boolean): PluginResult {
  const dir = project
    ? ensurePluginHostDir(TOOL_DOMAIN, cwd)
    : ensureUserPluginHostDir(TOOL_DOMAIN);
  const outcome = npmInstallIntoHost(dir, packageName);
  if (!outcome.ok) {
    return {
      type: PLUGIN_ADD,
      packageName,
      success: false,
      error: outcome.error,
    };
  }
  return {
    type: PLUGIN_ADD,
    packageName: outcome.installedName,
    success: true,
  };
}

/** npm-uninstall a package from a host dir. Pure of config concerns. */
export function npmUninstallFromHost(dir: string, packageName: string): boolean {
  try {
    execFileSync('npm', ['uninstall', packageName], {
      cwd: dir,
      stdio: ['ignore', process.stderr, process.stderr],
    });
    return true;
  } catch {
    return false;
  }
}

/** Remove a Tool plugin from its host dir (user-global by default, --project otherwise). */
export function removeToolPlugin(packageName: string, cwd: string, project: boolean): PluginResult {
  const dir = project
    ? resolveProjectPaths(cwd).pluginsDir(TOOL_DOMAIN)
    : resolveUserPaths().pluginsDir(TOOL_DOMAIN);
  if (!existsSync(join(dir, HOST_PACKAGE_JSON))) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `No tool plugins installed in ${dir}`,
    };
  }
  if (!npmUninstallFromHost(dir, packageName)) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `Failed to remove ${packageName}`,
    };
  }
  // No config entry to clean up — tool plugins auto-discover by marker.
  return { type: PLUGIN_REMOVE, packageName, success: true };
}
