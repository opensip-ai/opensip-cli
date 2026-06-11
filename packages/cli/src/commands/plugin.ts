// @fitness-ignore-file error-handling-quality -- npm install failures already stream to stderr via inherited stdio (downstream loader surfaces unresolved imports), and the package.json / node_modules walks are probes where unreadable/malformed entries mean "not installable" or "not a candidate" — same as absent.
/**
 * plugin command — manage project-local npm-installed plugins.
 *
 * Layout (no user-global plugin dir):
 *
 *   <project>/opensip-tools/.runtime/plugins/<domain>/
 *   ├── package.json       — host package; "dependencies" is the
 *   │                        plugin install state for this domain
 *   └── node_modules/      — npm-installed plugin packages
 *
 *   <project>/opensip-tools.config.yml
 *   plugins:
 *     fit:
 *       - "@org/fitness-checks"   — declares which installed packages
 *                                   discovery should LOAD. Required;
 *                                   discovery does not auto-load every
 *                                   installed package (silent loads
 *                                   would surprise users).
 *
 * `plugin add <pkg>` is the one-step install: writes the package to
 * .runtime/plugins/<domain>/node_modules AND adds it to plugins.<domain>
 * in the project config. After: `opensip-tools fit` loads it on next run.
 *
 * `plugin remove <pkg>` is the inverse: removes from node_modules AND
 * deletes from plugins.<domain>.
 *
 * `plugin list` walks .runtime/plugins/<domain>/node_modules + the
 * config to show what's installed and what's currently loaded.
 *
 * `plugin sync` is the post-clone bootstrap: reads plugins.<domain> from
 * the config and `npm install`s everything declared. Used by CI and
 * by users who clone a repo with custom plugins.
 *
 * Module layout
 * -------------
 * - This file owns the `plugin {list,add,remove,sync}` command bodies.
 * - `plugin/config-edit.ts` — YAML round-trip edits to plugins.<domain>.
 * - `plugin/domain-resolution.ts` — TOOL_DOMAIN + the pure validation
 *   logic that routes a spec to a domain / Tool host dir (no install).
 * - `plugin/host-dir.ts` — host package.json creation + installed-
 *   package introspection (incl. peer-dependency auto-install).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  discoverPackagesInNodeModules,
  readProjectPluginsList,
  resolveProjectPaths,
  resolveUserPaths,
  type PluginLayout,
} from '@opensip-tools/core';

import { getToolProvenanceForRun } from '../cli-context.js';

import { addToConfigPluginList, removeFromConfigPluginList } from './plugin/config-edit.js';
import {
  domainNames,
  isToolTarget,
  resolveDomain,
  TOOL_DOMAIN,
} from './plugin/domain-resolution.js';
import { ensurePluginHostDir, HOST_PACKAGE_JSON, isSafeNpmSpec } from './plugin/host-dir.js';
import {
  addToolPlugin,
  editPluginList,
  npmInstallIntoHost,
  npmUninstallFromHost,
  removeToolPlugin,
} from './plugin-host-ops.js';

import type { PluginInfo, PluginResult, SyncEntry } from '@opensip-tools/contracts';

/**
 * CommandResult discriminator literals. `as const` keeps the literal type
 * (so the PluginResult union still narrows) while satisfying
 * sonarjs/no-duplicate-string — no scattered eslint-disable needed.
 */
const PLUGIN_ADD = 'plugin-add' as const;
const PLUGIN_REMOVE = 'plugin-remove' as const;

/** Options shared by `plugin add`/`remove` for Tool-plugin scope selection. */
export interface PluginScopeOpts {
  /** Install/remove a Tool plugin in the project-local host dir instead of user-global. */
  readonly project?: boolean;
}

/**
 * Test-only export for the YAML-driven config edit so unit tests can
 * exercise the round-trip behaviour without spawning npm. Intentionally
 * not part of the public CLI API surface.
 */
export const __test = { editPluginList };

// =============================================================================
// COMMAND: plugin list
// =============================================================================

export async function pluginList(
  cwd: string = process.cwd(),
  layouts: readonly PluginLayout[] = [],
): Promise<PluginResult> {
  const { discoverPlugins } = await import('@opensip-tools/core');

  const plugins: PluginInfo[] = [];

  for (const layout of layouts) {
    const found = discoverPlugins(layout, cwd);
    for (const plugin of found) {
      plugins.push({
        domain: layout.domain,
        namespace: plugin.namespace,
        pluginType: plugin.type,
      });
    }
  }

  // Tool plugins are not a fit/sim layout — they auto-discover by marker
  // from the user-global host dir and (with --project) the project-local
  // one. Dedup by name; a project-local pin shadows a user-global install.
  const seenTools = new Set<string>();
  for (const dir of [
    resolveProjectPaths(cwd).pluginsDir(TOOL_DOMAIN),
    resolveUserPaths().pluginsDir(TOOL_DOMAIN),
  ]) {
    for (const pkg of discoverPackagesInNodeModules(join(dir, 'node_modules'), 'tool')) {
      if (seenTools.has(pkg.name)) continue;
      seenTools.add(pkg.name);
      plugins.push({ domain: TOOL_DOMAIN, namespace: pkg.name, pluginType: 'package' });
    }
  }

  // Additive provenance section (release 2.8.0): the tools admitted through
  // the compatibility gate this run, read from the per-run holder set at
  // bootstrap — NOT a disk re-scan. Surfaces source/identity/manifestHash
  // for bundled/installed/project-local tools alongside the discovered
  // fit/sim/tool plugin list above.
  const toolProvenance = getToolProvenanceForRun();

  return {
    type: 'plugin-list',
    plugins,
    totalCount: plugins.length,
    toolProvenance,
  };
}

// =============================================================================
// COMMAND: plugin add <package>
// =============================================================================

/**
 * Install a plugin AND add it to the project config in one step.
 *
 * Without the config update, the package wouldn't get loaded — making
 * "install" alone always incomplete. Single-step is the only sensible
 * default.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async to keep the Promise<PluginResult> contract; npm install is synchronous via execFileSync
export async function pluginAdd(
  packageName: string | undefined,
  cwd: string = process.cwd(),
  domainOverride?: string,
  layouts: readonly PluginLayout[] = [],
  scope: PluginScopeOpts = {},
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: PLUGIN_ADD,
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin add <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: PLUGIN_ADD,
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }

  // Tool-plugin path: install into the user-global (or --project) tool host
  // dir, no config entry (tools auto-discover by marker).
  if (isToolTarget(domainOverride, packageName, cwd)) {
    return addToolPlugin(packageName, cwd, scope.project === true);
  }

  // fit/sim domain path: install into the project-local domain host dir and
  // record in plugins.<domain> so discovery loads it.
  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: PLUGIN_ADD,
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...domains, TOOL_DOMAIN].join(', ')}`,
    };
  }

  const dir = ensurePluginHostDir(domain, cwd);
  const outcome = npmInstallIntoHost(dir, packageName);
  if (!outcome.ok) {
    return { type: PLUGIN_ADD, packageName, success: false, error: outcome.error };
  }
  // Update the project config so discovery actually loads it.
  addToConfigPluginList(resolveProjectPaths(cwd).configFile, domain, outcome.installedName);
  return { type: PLUGIN_ADD, packageName: outcome.installedName, success: true };
}

// =============================================================================
// COMMAND: plugin remove <package>
// =============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- async to keep the Promise<PluginResult> contract; npm uninstall is synchronous via execFileSync
export async function pluginRemove(
  packageName: string | undefined,
  cwd: string = process.cwd(),
  domainOverride?: string,
  layouts: readonly PluginLayout[] = [],
  scope: PluginScopeOpts = {},
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: PLUGIN_REMOVE,
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin remove <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }

  // Tool-plugin path: a tool removal targets the tool host dir directly.
  // Detection by an installed package can't read a published marker, so the
  // tool path is keyed on the explicit `--domain tool`.
  if (domainOverride === TOOL_DOMAIN) {
    return removeToolPlugin(packageName, cwd, scope.project === true);
  }

  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...domains, TOOL_DOMAIN].join(', ')}`,
    };
  }

  const paths = resolveProjectPaths(cwd);
  const dir = paths.pluginsDir(domain);

  if (!existsSync(join(dir, HOST_PACKAGE_JSON))) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `No plugins installed in ${domain}/`,
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
  removeFromConfigPluginList(paths.configFile, domain, packageName);
  return { type: PLUGIN_REMOVE, packageName, success: true };
}

// =============================================================================
// COMMAND: plugin sync (post-clone bootstrap)
// =============================================================================

/**
 * Install every plugin declared in `plugins.<domain>` for a given
 * domain (or all domains when none specified). Idempotent — re-running
 * after `git pull` updates the install state.
 *
 * The post-clone story: a developer clones a repo with declared
 * plugins, runs `opensip-tools plugin sync`, and the
 * .runtime/plugins/<domain>/node_modules trees are populated. Without
 * this, the first `opensip-tools fit` would warn about every declared
 * plugin being uninstalled.
 */
/* eslint-disable @typescript-eslint/require-await, sonarjs/cognitive-complexity --
 * async preserves Promise<PluginResult> contract; complexity is the
 * domain-loop × spec-loop × validate-then-install dispatch
 */
export async function pluginSync(
  cwd: string = process.cwd(),
  domainOverride?: string,
  layouts: readonly PluginLayout[] = [],
): Promise<PluginResult> {
  // pluginSync iterates the plugin-supporting domains contributed by the
  // registered tools (their `pluginLayout.domain`). A --domain override
  // narrows to one, but only if it is one of those domains — an arbitrary
  // string must not drive path construction outside .runtime/plugins/.
  const allDomains = domainNames(layouts);
  const domains: string[] =
    domainOverride && allDomains.includes(domainOverride) ? [domainOverride] : allDomains;

  const synced: SyncEntry[] = [];
  const errors: string[] = [];

  for (const domain of domains) {
    const declared = readProjectPluginsList(cwd, domain);
    if (!declared || declared.length === 0) continue;

    const dir = ensurePluginHostDir(domain, cwd);

    for (const spec of declared) {
      if (!isSafeNpmSpec(spec)) {
        errors.push(`${domain}: ignoring unsafe spec '${spec}'`);
        synced.push({ domain, package: spec, installed: false });
        continue;
      }
      try {
        execFileSync('npm', ['install', '--ignore-scripts', spec], {
          cwd: dir,
          stdio: ['ignore', process.stderr, process.stderr],
        });
        synced.push({ domain, package: spec, installed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${domain}/${spec}: ${message}`);
        synced.push({ domain, package: spec, installed: false });
      }
    }
  }

  return {
    type: 'plugin-sync',
    synced,
    ...(errors.length > 0 ? { errors } : {}),
    success: errors.length === 0,
  };
}
/* eslint-enable @typescript-eslint/require-await, sonarjs/cognitive-complexity */
