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
} from '@opensip-tools/core';

import {
  addToConfigPluginList,
  editPluginList,
  removeFromConfigPluginList,
} from './plugin/config-edit.js';
import {
  ensurePluginHostDir,
  findInstalledName,
  HOST_PACKAGE_JSON,
  installMissingPeers,
  isSafeNpmSpec,
  readHostDependencies,
} from './plugin/host-dir.js';

import type { PluginInfo, PluginResult, SyncEntry } from '@opensip-tools/contracts';

// =============================================================================
// VALIDATION HELPERS
// =============================================================================
//
// The plugin-supporting domains are NOT hardcoded here — they are sourced
// from the registered tools' `pluginLayout` descriptors (threaded in via
// `CliCommandsContext.pluginLayouts`). The kernel stays tool-agnostic and
// the tools remain the single source of truth (ADR-0009 corollary 1).

/** The set of plugin-supporting domain names from the contributed layouts. */
function domainNames(layouts: readonly PluginLayout[]): string[] {
  return layouts.map((l) => l.domain);
}

/**
 * Infer a target domain from a package name when --domain is omitted: the
 * first declared domain whose name appears as a word in the package name,
 * else the first declared domain. Domain names come from trusted
 * first-party layouts, so building a RegExp from them is safe.
 */
function inferDomain(packageName: string, domains: readonly string[]): string | undefined {
  const match = domains.find((d) => new RegExp(String.raw`\b${d}\b`).test(packageName));
  return match ?? domains[0];
}

/**
 * Resolve the target domain, rejecting arbitrary strings from --domain.
 * A bare cast would let a caller pass '../../etc' and drive path
 * construction outside opensip-tools/.runtime/.
 */
function resolveDomain(
  override: string | undefined,
  packageName: string,
  domains: readonly string[],
): string | undefined {
  if (override === undefined) return inferDomain(packageName, domains);
  return domains.includes(override) ? override : undefined;
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

  return {
    type: 'plugin-list',
    plugins,
    totalCount: plugins.length,
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
/* eslint-disable sonarjs/no-duplicate-string -- 'plugin-add' is the
 * CommandResult discriminator literal; factoring it into a constant
 * would defeat the type narrowing on the union arm.
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
      type: 'plugin-add',
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin add <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: 'plugin-add',
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }
  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: 'plugin-add',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${domains.join(', ')}`,
    };
  }

  const dir = ensurePluginHostDir(domain, cwd);
  const depsBefore = readHostDependencies(dir);

  try {
    // --ignore-scripts: refuse to execute plugin postinstall/preinstall
    // hooks. Plugins run via dynamic import() at fit time; they don't
    // legitimately need install-time code execution. This blocks
    // supply-chain attacks where a malicious plugin runs arbitrary
    // code during `npm install`.
    // Route npm's stdout to stderr so JSON-mode renderers (which write
    // structured output to the process stdout) are not contaminated by
    // `npm warn ...` / `added N packages` lines. npm progress is still
    // visible on the user's terminal because stderr is inherited.
    execFileSync('npm', ['install', '--ignore-scripts', packageName], {
      cwd: dir,
      stdio: ['ignore', process.stderr, process.stderr],
    });

    // Identify the package name as recorded in package.json (handles
    // local-path specs that don't carry a name in the spec itself).
    // For local-path specs (`/`, `./`, `file:`), the spec itself is NOT
    // a valid name — writing it into the config-file plugin list would
    // cause both discovery (which expects a real npm name) and a later
    // `plugin remove <spec>` to mis-handle the entry. If we can't
    // resolve the installed name, fail explicitly rather than persist
    // a broken entry.
    const resolvedName = findInstalledName(dir, packageName, depsBefore);
    const isLocalPathSpec =
      packageName.startsWith('/') || packageName.startsWith('.') || packageName.startsWith('file:');
    if (!resolvedName && isLocalPathSpec) {
      return {
        type: 'plugin-add',
        packageName,
        success: false,
        error: `Installed '${packageName}' but could not resolve the installed package name from package.json. The config was not updated; remove and retry.`,
      };
    }
    const installedName = resolvedName ?? packageName;

    installMissingPeers(dir, packageName, depsBefore);

    // Update the project config so discovery actually loads it.
    const paths = resolveProjectPaths(cwd);
    addToConfigPluginList(paths.configFile, domain, installedName);

    return {
      type: 'plugin-add',
      packageName: installedName,
      success: true,
    };
  } catch (error) {
    return {
      type: 'plugin-add',
      packageName,
      success: false,
      error: `Failed to add ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
/* eslint-enable sonarjs/no-duplicate-string */

// =============================================================================
// COMMAND: plugin remove <package>
// =============================================================================

/* eslint-disable sonarjs/no-duplicate-string -- 'plugin-remove' is the
 * CommandResult discriminator literal; factoring it into a constant
 * would defeat the type narrowing on the union arm.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async to keep the Promise<PluginResult> contract; npm uninstall is synchronous via execFileSync
export async function pluginRemove(
  packageName: string | undefined,
  cwd: string = process.cwd(),
  domainOverride?: string,
  layouts: readonly PluginLayout[] = [],
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: 'plugin-remove',
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin remove <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: 'plugin-remove',
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }

  const domains = domainNames(layouts);
  const domain = resolveDomain(domainOverride, packageName, domains);
  if (!domain) {
    return {
      type: 'plugin-remove',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${domains.join(', ')}`,
    };
  }

  const paths = resolveProjectPaths(cwd);
  const dir = paths.pluginsDir(domain);

  if (!existsSync(join(dir, HOST_PACKAGE_JSON))) {
    return {
      type: 'plugin-remove',
      packageName,
      success: false,
      error: `No plugins installed in ${domain}/`,
    };
  }

  try {
    execFileSync('npm', ['uninstall', packageName], {
      cwd: dir,
      stdio: ['ignore', process.stderr, process.stderr],
    });
    removeFromConfigPluginList(paths.configFile, domain, packageName);
    return {
      type: 'plugin-remove',
      packageName,
      success: true,
    };
  } catch {
    return {
      type: 'plugin-remove',
      packageName,
      success: false,
      error: `Failed to remove ${packageName}`,
    };
  }
}
/* eslint-enable sonarjs/no-duplicate-string */

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
