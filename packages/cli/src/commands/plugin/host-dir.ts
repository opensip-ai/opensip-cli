/**
 * @fileoverview Plugin host directory + installed-package introspection.
 *
 * Each plugin domain owns a `node_modules` tree under
 * `<project>/opensip-cli/.runtime/plugins/<domain>/`. This module
 * creates the host package.json, peeks at installed packages to
 * resolve real package names (for local-path specs that don't carry a
 * name), and walks peerDependencies for auto-install.
 *
 * Extracted from `commands/plugin.ts` so the install/uninstall flows
 * there stay focused on Commander + npm orchestration.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { resolveProjectPaths, resolveUserPaths } from '@opensip-cli/core';
import { satisfies as satisfiesSemver } from 'semver';

/** Filename of the host package.json that pins plugin installs. */
export const HOST_PACKAGE_JSON = 'package.json';

/**
 * Guard against argv-injection through npm. execFileSync doesn't spawn
 * a shell, so shell metacharacters are safe, but any arg starting with
 * '-' would be consumed by npm as a flag (e.g. '-g', '--prefix=/etc').
 */
export function isSafeNpmSpec(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith('-')) return false;
  return true;
}

function isSafePeerPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name);
}

/** Create (if absent) a plugin host dir + its host package.json; returns `dir`. */
export function ensureHostDir(dir: string, domain: string): string {
  mkdirSync(dir, { recursive: true });
  const pkgJsonPath = join(dir, HOST_PACKAGE_JSON);
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: `opensip-cli-${domain}-plugins`,
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

/** Project-local plugin host dir: `<project>/opensip-cli/.runtime/plugins/<domain>`. */
export function ensurePluginHostDir(domain: string, cwd: string): string {
  return ensureHostDir(resolveProjectPaths(cwd).pluginsDir(domain), domain);
}

/**
 * User-global plugin host dir: `~/.opensip-cli/plugins/<domain>`. Used by
 * the `tool` domain so a `plugin add <tool>` makes the subcommand available
 * across every project (the cross-project analogue of `npm i -g`).
 */
export function ensureUserPluginHostDir(domain: string): string {
  return ensureHostDir(resolveUserPaths().pluginsDir(domain), domain);
}

/**
 * After installing a plugin, look at its peerDependencies and install any that
 * Node cannot already resolve from the plugin host. This follows ordinary peer
 * dependency semantics: a project dependency in an ancestor `node_modules`
 * satisfies the plugin without downloading a second copy into the private host.
 * Best-effort: missing peers produce no error here; the loader surfaces a clear
 * error if the plugin still cannot resolve its imports.
 */
export function installMissingPeers(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): void {
  const installed = findInstalledPackage(dir, requestedSpec, depsBefore);
  if (!installed) return;

  const peerDeps = installed.peerDependencies ?? {};
  const installedAtRoot = new Set(safeReaddirScopedAndFlat(join(dir, 'node_modules')));
  const requireFromHost = createRequire(join(dir, '__opensip_peer_resolution__.cjs'));
  const missing = Object.entries(peerDeps).filter(([name, range]) => {
    if (!isSafePeerPackageName(name)) return true;
    const rootPackage = join(dir, 'node_modules', name);
    const compatibleAtRoot =
      installedAtRoot.has(name) && isCompatiblePeerPackage(rootPackage, name, range);
    return !compatibleAtRoot && !canResolveAncestorPeer(dir, requireFromHost, name, range);
  });
  if (missing.length === 0) return;

  for (const [name, range] of missing) {
    if (!isSafePeerPackageName(name) || !isSafeNpmSpec(name)) continue;
    if (typeof range !== 'string' || !isSafeNpmSpec(range)) continue;
    try {
      execFileSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `${name}@${range}`],
        {
          // Bounded (Plan 01): package management against a possibly-wedged registry.
          timeout: 5 * 60_000,
          maxBuffer: 32 * 1024 * 1024,
          cwd: dir,
          stdio: ['ignore', process.stderr, process.stderr],
        },
      );
    } catch {
      // Loader will surface unresolved imports; swallow here.
    }
  }
}

function canResolveAncestorPeer(
  hostDir: string,
  requireFromHost: { resolve(id: string): string },
  name: string,
  range: string,
): boolean {
  let current = hostDir;
  let physicalPackagePath: string | undefined;
  while (true) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(candidate)) {
      physicalPackagePath = candidate;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (physicalPackagePath === undefined) return false;
  try {
    if (!isCompatiblePeerPackage(physicalPackagePath, name, range)) return false;
    const packageReal = realpathSync(physicalPackagePath);
    const resolvedReal = realpathSync(requireFromHost.resolve(name));
    const rel = relative(packageReal, resolvedReal);
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function isCompatiblePeerPackage(packagePath: string, name: string, range: string): boolean {
  const manifest = readPackageJson(join(packagePath, HOST_PACKAGE_JSON));
  if (manifest?.name !== name || typeof manifest.version !== 'string') return false;
  try {
    return satisfiesSemver(manifest.version, range);
  } catch {
    return false;
  }
}

export function findInstalledName(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): string | undefined {
  return findInstalledPackage(dir, requestedSpec, depsBefore)?.name;
}

function findInstalledLocalPackage(
  dir: string,
  nodeModulesDir: string,
  requestedSpec: string,
): PackageManifest | undefined {
  const requestedLocalPath = resolveLocalSpecPath(dir, requestedSpec);
  if (requestedLocalPath === undefined) return undefined;
  const host = readPackageJson(join(dir, HOST_PACKAGE_JSON));
  for (const [name, spec] of Object.entries(host?.dependencies ?? {})) {
    if (resolveLocalSpecPath(dir, spec) !== requestedLocalPath) continue;
    const pkg = readPackageJson(join(nodeModulesDir, name, HOST_PACKAGE_JSON));
    if (pkg?.name === name) return pkg;
  }
  return undefined;
}

function findInstalledPackage(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): PackageManifest | undefined {
  const nodeModulesDir = join(dir, 'node_modules');
  if (!existsSync(nodeModulesDir)) return undefined;

  const namedSpec = extractNameFromSpec(requestedSpec);
  if (namedSpec) {
    const pkg = readPackageJson(join(nodeModulesDir, namedSpec, HOST_PACKAGE_JSON));
    if (pkg) return pkg;
  }

  const localPackage = findInstalledLocalPackage(dir, nodeModulesDir, requestedSpec);
  if (localPackage !== undefined) return localPackage;

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

function resolveLocalSpecPath(dir: string, spec: string): string | undefined {
  const raw = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  if (!isAbsolute(raw) && !raw.startsWith('.')) return undefined;
  return resolve(dir, raw);
}

export function readHostDependencies(dir: string): Set<string> {
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

interface PackageManifest {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(path: string): PackageManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
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
      } catch {
        /* unreadable scope */
      }
    } else if (!entry.startsWith('.')) {
      out.push(entry);
    }
  }
  return out;
}
