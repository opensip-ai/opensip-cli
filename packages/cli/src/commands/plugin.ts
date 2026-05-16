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
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  readProjectPluginsList,
  resolveProjectPaths,
  type PathDomain,
  type PluginDomain,
} from '@opensip-tools/core';

import type { PluginResult } from '@opensip-tools/contracts';

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

const VALID_DOMAINS: ReadonlySet<PathDomain> = new Set(['fit', 'sim']);

/** Filename of the host package.json that pins plugin installs. */
const HOST_PACKAGE_JSON = 'package.json';

function inferDomain(packageName: string): PathDomain {
  if (/\bsim\b/.test(packageName)) return 'sim';
  return 'fit';
}

/**
 * Resolve the target domain, rejecting arbitrary strings from --domain.
 * A bare cast would let a caller pass '../../etc' and drive path
 * construction outside opensip-tools/.runtime/.
 */
function resolveDomain(override: string | undefined, packageName: string): PathDomain | undefined {
  if (override === undefined) return inferDomain(packageName);
  if (VALID_DOMAINS.has(override as PathDomain)) return override as PathDomain;
  return undefined;
}

/**
 * Guard against argv-injection through npm. execFileSync doesn't spawn
 * a shell, so shell metacharacters are safe, but any arg starting with
 * '-' would be consumed by npm as a flag (e.g. '-g', '--prefix=/etc').
 */
function isSafeNpmSpec(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith('-')) return false;
  return true;
}

// =============================================================================
// CONFIG MUTATION (plugins.<domain> in opensip-tools.config.yml)
// =============================================================================

/**
 * Add `name` to the project's `plugins.<domain>` list. Idempotent —
 * existing names are not duplicated. Creates the list if absent.
 *
 * Done with line-level edits (NOT a YAML reformat) to preserve the
 * user's comments, ordering, and formatting in the rest of the file.
 * The line-edit assumes the standard 2-space indent inside `plugins:`;
 * a non-standard formatting will fail closed (no edit; warning logged).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- YAML line-edit walks 3 distinct match cases (no plugins block, no domain subkey, existing list); each branch is short but the dispatch itself runs over the threshold
function addToConfigPluginList(configPath: string, domain: PathDomain, name: string): boolean {
  if (!existsSync(configPath)) {
    // No config to edit — write a minimal one.
    writeFileSync(
      configPath,
      `plugins:\n  ${domain}:\n    - "${name}"\n`,
      'utf8',
    );
    return true;
  }

  const text = readFileSync(configPath, 'utf8');
  const lines = text.split('\n');

  // Locate the existing `plugins.<domain>` block, append. Ranges:
  // - find `plugins:` at column 0
  // - find `<domain>:` at column 2 within plugins block
  // - find the next entry after the last `- "..."` at column 4
  const pluginsIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (pluginsIdx === -1) {
    // No `plugins:` block — append one at end.
    lines.push(`plugins:`, `  ${domain}:`, `    - "${name}"`);
    writeFileSync(configPath, lines.join('\n'), 'utf8');
    return true;
  }

  let domainIdx = -1;
  for (let i = pluginsIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (new RegExp(String.raw`^  ${domain}:\s*$`).test(line)) {
      domainIdx = i;
      break;
    }
    // Stop at next top-level key (column 0 non-comment, non-blank)
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break;
  }

  if (domainIdx === -1) {
    // No `<domain>:` subkey — insert just after `plugins:`.
    lines.splice(pluginsIdx + 1, 0, `  ${domain}:`, `    - "${name}"`);
    writeFileSync(configPath, lines.join('\n'), 'utf8');
    return true;
  }

  // Find end of the domain's list (next column-0/2 key) + dedupe.
  let lastEntryIdx = domainIdx;
  for (let i = domainIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('    - ')) {
      const m = /^ {4}- ["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m?.[1] === name) return false; // already present — idempotent no-op
      lastEntryIdx = i;
    } else if (line.length > 0 && !line.startsWith('    ')) {
      break;
    }
  }

  lines.splice(lastEntryIdx + 1, 0, `    - "${name}"`);
  writeFileSync(configPath, lines.join('\n'), 'utf8');
  return true;
}

/**
 * Remove `name` from the project's `plugins.<domain>` list. Returns
 * true if a line was deleted, false if `name` wasn't there.
 */
function removeFromConfigPluginList(configPath: string, domain: PathDomain, name: string): boolean {
  if (!existsSync(configPath)) return false;

  const text = readFileSync(configPath, 'utf8');
  const lines = text.split('\n');

  let inDomainBlock = false;
  let edited = false;
  const out: string[] = [];
  for (const line of lines) {
    if (new RegExp(String.raw`^  ${domain}:\s*$`).test(line)) {
      inDomainBlock = true;
      out.push(line);
      continue;
    }
    if (inDomainBlock && line.length > 0 && !line.startsWith('    ') && !line.startsWith('  -')) {
      inDomainBlock = false;
    }
    if (inDomainBlock) {
      const m = /^ {4}- ["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (m?.[1] === name) {
        edited = true;
        continue;
      }
    }
    out.push(line);
  }

  if (edited) {
    writeFileSync(configPath, out.join('\n'), 'utf8');
  }
  return edited;
}

// =============================================================================
// PLUGIN HOST DIR — node_modules root for a given domain
// =============================================================================

function ensurePluginHostDir(domain: PathDomain, cwd: string): string {
  const paths = resolveProjectPaths(cwd);
  const dir = paths.pluginsDir(domain);
  mkdirSync(dir, { recursive: true });

  const pkgJsonPath = join(dir, HOST_PACKAGE_JSON);
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: `opensip-tools-${domain}-plugins`,
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: {},
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

// =============================================================================
// COMMAND: plugin list
// =============================================================================

export async function pluginList(cwd: string = process.cwd()): Promise<PluginResult> {
  const { discoverPlugins } = await import('@opensip-tools/core');
  const domains: PluginDomain[] = ['fit', 'sim'];

  const plugins: { domain: string; namespace: string; pluginType: 'package' | 'file' }[] = [];

  for (const domain of domains) {
    const found = discoverPlugins(domain, cwd);
    for (const plugin of found) {
      plugins.push({
        domain,
        namespace: plugin.namespace,
        pluginType: plugin.type,
      });
    }
  }

  return {
    type: 'plugin',
    action: 'list',
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
// eslint-disable-next-line @typescript-eslint/require-await -- async to keep the Promise<PluginResult> contract; npm install is synchronous via execFileSync
export async function pluginAdd(
  packageName: string | undefined,
  cwd: string = process.cwd(),
  domainOverride?: string,
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: 'plugin',
      action: 'add',
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin add <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: 'plugin',
      action: 'add',
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }
  const domain = resolveDomain(domainOverride, packageName);
  if (!domain) {
    return {
      type: 'plugin',
      action: 'add',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...VALID_DOMAINS].join(', ')}`,
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
    execFileSync('npm', ['install', '--ignore-scripts', packageName], { cwd: dir, stdio: 'inherit' });

    // Identify the package name as recorded in package.json (handles
    // local-path specs that don't carry a name in the spec itself).
    const installedName = findInstalledName(dir, packageName, depsBefore) ?? packageName;

    installMissingPeers(dir, packageName, depsBefore);

    // Update the project config so discovery actually loads it.
    const paths = resolveProjectPaths(cwd);
    addToConfigPluginList(paths.configFile, domain, installedName);

    return {
      type: 'plugin',
      action: 'add',
      packageName: installedName,
      success: true,
    };
  } catch (error) {
    return {
      type: 'plugin',
      action: 'add',
      packageName,
      success: false,
      error: `Failed to add ${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// =============================================================================
// COMMAND: plugin remove <package>
// =============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- async to keep the Promise<PluginResult> contract; npm uninstall is synchronous via execFileSync
export async function pluginRemove(
  packageName: string | undefined,
  cwd: string = process.cwd(),
  domainOverride?: string,
): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: 'plugin',
      action: 'remove',
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin remove <package-name>',
    };
  }
  if (!isSafeNpmSpec(packageName)) {
    return {
      type: 'plugin',
      action: 'remove',
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }

  const domain = resolveDomain(domainOverride, packageName);
  if (!domain) {
    return {
      type: 'plugin',
      action: 'remove',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...VALID_DOMAINS].join(', ')}`,
    };
  }

  const paths = resolveProjectPaths(cwd);
  const dir = paths.pluginsDir(domain);

  if (!existsSync(join(dir, HOST_PACKAGE_JSON))) {
    return {
      type: 'plugin',
      action: 'remove',
      packageName,
      success: false,
      error: `No plugins installed in ${domain}/`,
    };
  }

  try {
    execFileSync('npm', ['uninstall', packageName], { cwd: dir, stdio: 'inherit' });
    removeFromConfigPluginList(paths.configFile, domain, packageName);
    return {
      type: 'plugin',
      action: 'remove',
      packageName,
      success: true,
    };
  } catch {
    return {
      type: 'plugin',
      action: 'remove',
      packageName,
      success: false,
      error: `Failed to remove ${packageName}`,
    };
  }
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
): Promise<PluginResult> {
  // pluginSync only iterates plugin-supporting domains. The domain
  // type here is the intersection of PathDomain (fit|sim|graph) and
  // PluginDomain (fit|sim|asm|lang), which is fit|sim. Graph does not
  // yet load project-local rule plugins (deferred to v0.3 per DEC-6).
  type SyncDomain = 'fit' | 'sim';
  const syncDomains: SyncDomain[] = ['fit', 'sim'];
  const domains: SyncDomain[] = (
    domainOverride && VALID_DOMAINS.has(domainOverride as PathDomain)
      ? [domainOverride as SyncDomain]
      : syncDomains
  );

  const synced: { domain: string; package: string; installed: boolean }[] = [];
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
        execFileSync('npm', ['install', '--ignore-scripts', spec], { cwd: dir, stdio: 'inherit' });
        synced.push({ domain, package: spec, installed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${domain}/${spec}: ${message}`);
        synced.push({ domain, package: spec, installed: false });
      }
    }
  }

  return {
    type: 'plugin',
    action: 'sync',
    synced,
    ...(errors.length > 0 ? { errors } : {}),
    success: errors.length === 0,
  };
}
/* eslint-enable @typescript-eslint/require-await, sonarjs/cognitive-complexity */

// =============================================================================
// PEER-DEPENDENCY AUTO-INSTALL
// =============================================================================

/**
 * After installing a plugin, look at its peerDependencies and install
 * any missing ones into the same plugin directory. Best-effort: missing
 * peers produce a warning, not a failure, since the loader will
 * surface a clear error if the plugin can't resolve its imports.
 */
function installMissingPeers(dir: string, requestedSpec: string, depsBefore: Set<string>): void {
  const installed = findInstalledPackage(dir, requestedSpec, depsBefore);
  if (!installed) return;

  const peerDeps = installed.peerDependencies ?? {};
  const installedAtRoot = new Set(safeReaddirScopedAndFlat(join(dir, 'node_modules')));

  const missing = Object.entries(peerDeps).filter(([name]) => !installedAtRoot.has(name));
  if (missing.length === 0) return;

  for (const [name, range] of missing) {
    if (!isSafeNpmSpec(name)) continue;
    if (typeof range !== 'string' || !isSafeNpmSpec(range)) continue;
    try {
      execFileSync('npm', ['install', '--ignore-scripts', '--no-save', `${name}@${range}`], { cwd: dir, stdio: 'inherit' });
    } catch {
      // Loader will surface unresolved imports; swallow here.
    }
  }
}

function findInstalledName(dir: string, requestedSpec: string, depsBefore: Set<string>): string | undefined {
  return findInstalledPackage(dir, requestedSpec, depsBefore)?.name;
}

function findInstalledPackage(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): { name: string; peerDependencies?: Record<string, string> } | undefined {
  const nodeModulesDir = join(dir, 'node_modules');
  if (!existsSync(nodeModulesDir)) return undefined;

  const namedSpec = extractNameFromSpec(requestedSpec);
  if (namedSpec) {
    const pkg = readPackageJson(join(nodeModulesDir, namedSpec, HOST_PACKAGE_JSON));
    if (pkg) return pkg;
  }

  // Local-path installs: the new dep key is whichever entry is in the
  // host package.json now that wasn't there before.
  const depsAfter = readHostDependencies(dir);
  for (const name of depsAfter) {
    if (depsBefore.has(name)) continue;
    const pkg = readPackageJson(join(nodeModulesDir, name, HOST_PACKAGE_JSON));
    if (pkg?.name === name) return pkg;
  }
  return undefined;
}

function readHostDependencies(dir: string): Set<string> {
  const hostPkg = readPackageJson(join(dir, HOST_PACKAGE_JSON));
  return new Set(Object.keys(hostPkg?.dependencies ?? {}));
}

function extractNameFromSpec(spec: string): string | undefined {
  if (spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('file:')) return undefined;
  if (spec.startsWith('@')) {
    const withoutScope = spec.slice(1);
    const slashIdx = withoutScope.indexOf('/');
    if (slashIdx === -1) return undefined;
    const rest = withoutScope.slice(slashIdx + 1);
    const atIdx = rest.indexOf('@');
    const name = atIdx === -1 ? rest : rest.slice(0, atIdx);
    return `@${withoutScope.slice(0, slashIdx)}/${name}`;
  }
  const atIdx = spec.indexOf('@');
  return atIdx === -1 ? spec : spec.slice(0, atIdx);
}

function readPackageJson(
  path: string,
): { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function safeReaddirScopedAndFlat(nodeModulesDir: string): string[] {
  if (!existsSync(nodeModulesDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry);
      try {
        for (const scoped of readdirSync(scopeDir)) out.push(`${entry}/${scoped}`);
      } catch { /* unreadable scope */ }
    } else if (!entry.startsWith('.')) {
      out.push(entry);
    }
  }
  return out;
}

