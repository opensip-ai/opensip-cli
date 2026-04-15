/**
 * plugin command — manage installed plugins
 */

import type { PluginDomain } from '@opensip-tools/core';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PluginResult } from '../types.js';

// ---------------------------------------------------------------------------
// Plugin helpers
// ---------------------------------------------------------------------------

const VALID_DOMAINS: ReadonlySet<PluginDomain> = new Set(['fit', 'sim', 'asm']);

export function inferDomain(packageName: string): PluginDomain {
  if (/\bsim\b/.test(packageName)) return 'sim';
  return 'fit';
}

/**
 * Resolve the target domain, rejecting arbitrary strings from --domain. A
 * bare cast would let a caller pass '../../etc' and drive getPluginDir
 * outside ~/.opensip-tools/.
 */
function resolveDomain(override: string | undefined, packageName: string): PluginDomain | undefined {
  if (override === undefined) return inferDomain(packageName);
  if (VALID_DOMAINS.has(override as PluginDomain)) return override as PluginDomain;
  return undefined;
}

/**
 * Guard against argv-injection through npm. execFileSync doesn't spawn a
 * shell, so shell metacharacters are safe, but any arg starting with '-'
 * would be consumed by npm as a flag (e.g. '-g', '--prefix=/etc'). Reject
 * those before they reach the npm process.
 */
function isSafeNpmSpec(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith('-')) return false;
  return true;
}

export async function pluginList(): Promise<PluginResult> {
  const { discoverPlugins } = await import('@opensip-tools/core');
  const domains: PluginDomain[] = ['fit', 'sim'];

  const plugins: Array<{ domain: string; namespace: string; pluginType: 'package' | 'file' }> = [];

  for (const domain of domains) {
    const found = discoverPlugins(domain);
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

export async function pluginInstall(packageName: string | undefined, domainOverride?: string): Promise<PluginResult> {
  if (!packageName) {
    return {
      type: 'plugin',
      action: 'install',
      packageName: '',
      success: false,
      error: 'No package name provided. Usage: opensip-tools plugin install <package-name>',
    };
  }

  if (!isSafeNpmSpec(packageName)) {
    return {
      type: 'plugin',
      action: 'install',
      packageName,
      success: false,
      error: `Invalid package spec '${packageName}' — must not start with '-' (would be interpreted as an npm flag)`,
    };
  }

  const domain = resolveDomain(domainOverride, packageName);
  if (!domain) {
    return {
      type: 'plugin',
      action: 'install',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...VALID_DOMAINS].join(', ')}`,
    };
  }
  const { getPluginDir } = await import('@opensip-tools/core');
  const dir = getPluginDir(domain);

  // Ensure directory and package.json exist
  mkdirSync(dir, { recursive: true });
  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: `opensip-tools-${domain}-plugins`,
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: {},
    }, null, 2));
  }

  // Snapshot host deps before the install so we can identify which key
  // `npm install` added when the spec is a local path and has no inherent name.
  const depsBefore = readHostDependencies(dir);

  try {
    execFileSync('npm', ['install', packageName], { cwd: dir, stdio: 'inherit' });

    // npm does not reliably auto-install peerDependencies for packages
    // installed via file: specs (local paths) or workspaces. Read the
    // installed plugin's peerDependencies and install any that are missing,
    // so plugins can cleanly import @opensip-tools/core at load time.
    installMissingPeers(dir, packageName, depsBefore);

    return {
      type: 'plugin',
      action: 'install',
      packageName,
      success: true,
    };
  } catch (err) {
    return {
      type: 'plugin',
      action: 'install',
      packageName,
      success: false,
      error: `Failed to install ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Locate the installed plugin's package.json and install any missing
 * peerDependencies into the same plugin directory. Best-effort: missing
 * peers produce a warning, not a failure, since the loader will surface
 * a clear error if the plugin can't resolve its imports.
 */
function installMissingPeers(dir: string, requestedSpec: string, depsBefore: Set<string>): void {
  const installed = findInstalledPackage(dir, requestedSpec, depsBefore);
  if (!installed) return;

  const peerDeps = installed.peerDependencies ?? {};
  const installedAtRoot = new Set(safeReaddirScopedAndFlat(join(dir, 'node_modules')));

  const missing = Object.entries(peerDeps).filter(([name]) => !installedAtRoot.has(name));
  if (missing.length === 0) return;

  for (const [name, range] of missing) {
    // Skip peer entries that would become npm flags (e.g. a malicious
    // plugin declaring `"-g": "*"` as a peerDependency).
    if (!isSafeNpmSpec(name)) continue;
    if (typeof range !== 'string' || !isSafeNpmSpec(range)) continue;
    try {
      // --no-save: peers land in node_modules but are not recorded as
      // host-level dependencies, so discovery doesn't list them as plugins.
      execFileSync('npm', ['install', '--no-save', `${name}@${range}`], { cwd: dir, stdio: 'inherit' });
    } catch {
      // Swallow — loader will report if the peer is ultimately unreachable.
    }
  }
}

function findInstalledPackage(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): { name: string; peerDependencies?: Record<string, string> } | undefined {
  const nodeModulesDir = join(dir, 'node_modules');
  if (!existsSync(nodeModulesDir)) return undefined;

  // Derive the package name from named specs like "@scope/name[@ver]" or
  // "name[@ver]". For local paths (starts with / or .), fall through.
  const namedSpec = extractNameFromSpec(requestedSpec);
  if (namedSpec) {
    const pkg = readPackageJson(join(nodeModulesDir, namedSpec, 'package.json'));
    if (pkg) return pkg;
  }

  // Fallback for local-path installs: the new dep key is whichever entry
  // appears in the host package.json now that wasn't there before.
  const depsAfter = readHostDependencies(dir);
  for (const name of depsAfter) {
    if (depsBefore.has(name)) continue;
    const pkg = readPackageJson(join(nodeModulesDir, name, 'package.json'));
    if (pkg?.name === name) return pkg;
  }
  return undefined;
}

function readHostDependencies(dir: string): Set<string> {
  const hostPkg = readPackageJson(join(dir, 'package.json'));
  return new Set(Object.keys(hostPkg?.dependencies ?? {}));
}

function extractNameFromSpec(spec: string): string | undefined {
  if (spec.startsWith('/') || spec.startsWith('.') || spec.startsWith('file:')) return undefined;
  if (spec.startsWith('@')) {
    // @scope/name or @scope/name@version
    const withoutScope = spec.slice(1);
    const slashIdx = withoutScope.indexOf('/');
    if (slashIdx < 0) return undefined;
    const rest = withoutScope.slice(slashIdx + 1);
    const atIdx = rest.indexOf('@');
    const name = atIdx < 0 ? rest : rest.slice(0, atIdx);
    return `@${withoutScope.slice(0, slashIdx)}/${name}`;
  }
  const atIdx = spec.indexOf('@');
  return atIdx < 0 ? spec : spec.slice(0, atIdx);
}

function readPackageJson(
  path: string,
): { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
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

export async function pluginRemove(packageName: string | undefined, domainOverride?: string): Promise<PluginResult> {
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
  const { getPluginDir } = await import('@opensip-tools/core');
  const dir = getPluginDir(domain);

  if (!existsSync(join(dir, 'package.json'))) {
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
