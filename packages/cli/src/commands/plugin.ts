// @fitness-ignore-file error-handling-quality -- npm install failures already stream to stderr via inherited stdio (downstream loader surfaces unresolved imports), and the package.json / node_modules walks are probes where unreadable/malformed entries mean "not installable" or "not a candidate" — same as absent.
/**
 * plugin command — manage a PACK-SUPPORTING tool's project-local
 * npm-installed extension packs (fit/sim checks, recipes, scenarios).
 *
 * The pack ops are mounted UNDER each pack-supporting tool primary —
 * `opensip fit plugin {add|list|remove|sync}` (domain pre-bound to `fit`),
 * `opensip sim plugin {…}` (domain `sim`). There is no top-level
 * `opensip plugin` command, and no `--domain`/`--type` flag: the tool the
 * subcommand hangs off of IS the domain. Whole Tool plugins (platform
 * subcommands) are installed/uninstalled with `opensip tools …`, never here.
 *
 * Layout (no user-global plugin dir):
 *
 *   <project>/opensip-cli/.runtime/plugins/<domain>/
 *   ├── package.json       — host package; "dependencies" is the
 *   │                        plugin install state for this domain
 *   └── node_modules/      — npm-installed plugin packages
 *
 *   <project>/opensip-cli.config.yml
 *   plugins:
 *     fit:
 *       - "@org/fitness-checks"   — declares which installed packages
 *                                   discovery should LOAD. Required;
 *                                   discovery does not auto-load every
 *                                   installed package (silent loads
 *                                   would surprise users).
 *
 * `<tool> plugin add <pkg>` is the one-step install: writes the package to
 * .runtime/plugins/<domain>/node_modules AND adds it to plugins.<domain>
 * in the project config. After: `opensip fit` loads it on next run.
 *
 * `<tool> plugin remove <pkg>` is the inverse: removes from node_modules AND
 * deletes from plugins.<domain>.
 *
 * `<tool> plugin list` walks .runtime/plugins/<domain>/node_modules + the
 * config to show what's installed and what's currently loaded.
 *
 * `<tool> plugin sync` is the post-clone bootstrap: reads plugins.<domain> from
 * the config and `npm install`s everything declared. Used by CI and
 * by users who clone a repo with custom plugins.
 *
 * Module layout
 * -------------
 * - This file owns the `plugin {list,add,remove,sync}` command bodies.
 * - `plugin/config-edit.ts` — YAML round-trip edits to plugins.<domain>.
 * - `plugin/domain-resolution.ts` — TOOL_DOMAIN + the pure validation
 *   logic that routes a spec to a domain (no install).
 * - `plugin/host-dir.ts` — host package.json creation + installed-
 *   package introspection (incl. peer-dependency auto-install).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  readProjectPluginsList,
  resolveProjectPaths,
  type PluginLayout,
  type ToolProvenance,
} from '@opensip-cli/core';

import { addToConfigPluginList, removeFromConfigPluginList } from './plugin/config-edit.js';
import { domainNames, resolveDomain } from './plugin/domain-resolution.js';
import { ensurePluginHostDir, HOST_PACKAGE_JSON, isSafeNpmSpec } from './plugin/host-dir.js';
import { editPluginList, npmInstallIntoHost, npmUninstallFromHost } from './plugin-host-ops.js';

import type { PluginInfo, PluginResult, SyncEntry } from '@opensip-cli/contracts';

/**
 * CommandResult discriminator literals. `as const` keeps the literal type
 * (so the PluginResult union still narrows) while satisfying
 * sonarjs/no-duplicate-string — no scattered eslint-disable needed.
 */
const PLUGIN_ADD = 'plugin-add' as const;
const PLUGIN_REMOVE = 'plugin-remove' as const;

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
  // The admitted-tool provenance for this run, read by the command handler from
  // the entered RunScope and passed in (keeps this function pure). Default `[]`.
  toolProvenance: readonly ToolProvenance[] = [],
): Promise<PluginResult> {
  const { discoverPlugins } = await import('@opensip-cli/core');

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

  // Whole Tool plugins are NOT listed here — `<tool> plugin list` is scoped to
  // the tool's own extension-pack domain (fit/sim packs). Installed Tool
  // plugins (platform subcommands) are listed by `opensip tools list`.
  //
  // Additive provenance section (launch): the tools admitted through the
  // compatibility gate this run — passed in by the command handler from the
  // entered RunScope (`currentScope().toolProvenance`), NOT a disk re-scan.
  // Surfaces source/identity/manifestHash for the admitted tools alongside the
  // discovered pack list above.
  return {
    type: 'plugin-list',
    domains: domainsForList(layouts),
    plugins,
    totalCount: plugins.length,
    toolProvenance,
  };
}

function domainsForList(layouts: readonly PluginLayout[]): string[] {
  return layouts.map((layout) => layout.domain);
}

// =============================================================================
// COMMAND: plugin add <package>
// =============================================================================

/**
 * Install a pack AND add it to the project config in one step, scoped to the
 * caller's bound `domain` (the pack-supporting tool the subcommand hangs off
 * of — `fit`/`sim`). Whole Tool plugins are NOT installable here; use
 * `opensip tools install`.
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
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: PLUGIN_ADD,
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip <tool> plugin add <package-name>',
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

  // The domain is bound by the host (the pack-supporting tool primary the
  // subcommand mounts under), so it is always one of the contributed layouts;
  // resolve/validate defensively against them.
  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: PLUGIN_ADD,
      packageName,
      success: false,
      error: `Invalid domain '${String(domainOverride)}' — expected one of: ${domains.join(', ')}`,
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
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: PLUGIN_REMOVE,
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip <tool> plugin remove <package-name>',
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

  // The domain is bound by the host (the pack-supporting tool primary). Whole
  // Tool plugins are uninstalled with `opensip tools uninstall`, not here.
  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: PLUGIN_REMOVE,
      packageName,
      success: false,
      error: `Invalid domain '${String(domainOverride)}' — expected one of: ${domains.join(', ')}`,
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
 * plugins, runs `opensip plugin sync`, and the
 * .runtime/plugins/<domain>/node_modules trees are populated. Without
 * this, the first `opensip fit` would warn about every declared
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
