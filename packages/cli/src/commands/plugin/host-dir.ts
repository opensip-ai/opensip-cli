// @fitness-ignore-file error-handling-quality -- package.json walks / npm-install probes where unreadable/malformed entries mean "not installable" / "not a candidate" — same as absent; npm errors already stream to stderr via inherited stdio.
// @fitness-ignore-file unbounded-memory -- reads package.json files; bounded by standard npm package metadata shape.
/**
 * @fileoverview Plugin host directory + installed-package introspection.
 *
 * Each plugin domain owns a `node_modules` tree under
 * `<project>/opensip-tools/.runtime/plugins/<domain>/`. This module
 * creates the host package.json, peeks at installed packages to
 * resolve real package names (for local-path specs that don't carry a
 * name), and walks peerDependencies for auto-install.
 *
 * Extracted from `commands/plugin.ts` so the install/uninstall flows
 * there stay focused on Commander + npm orchestration.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProjectPaths, resolveUserPaths } from '@opensip-tools/core';

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

/** Create the host package.json (if absent) for a plugin host dir + return the dir. */
/** Create (if absent) a plugin host dir + its host package.json; returns `dir`. */
export function ensureHostDir(dir: string, domain: string): string {
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

/** Project-local plugin host dir: `<project>/opensip-tools/.runtime/plugins/<domain>`. */
export function ensurePluginHostDir(domain: string, cwd: string): string {
  return ensureHostDir(resolveProjectPaths(cwd).pluginsDir(domain), domain);
}

/**
 * User-global plugin host dir: `~/.opensip-tools/plugins/<domain>`. Used by
 * the `tool` domain so a `plugin add <tool>` makes the subcommand available
 * across every project (the cross-project analogue of `npm i -g`).
 */
export function ensureUserPluginHostDir(domain: string): string {
  return ensureHostDir(resolveUserPaths().pluginsDir(domain), domain);
}

/**
 * After installing a plugin, look at its peerDependencies and install
 * any missing ones into the same plugin directory. Best-effort: missing
 * peers produce no error here, the loader will surface a clear error if
 * the plugin can't resolve its imports.
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

  const missing = Object.entries(peerDeps).filter(([name]) => !installedAtRoot.has(name));
  if (missing.length === 0) return;

  for (const [name, range] of missing) {
    if (!isSafeNpmSpec(name)) continue;
    if (typeof range !== 'string' || !isSafeNpmSpec(range)) continue;
    try {
      execFileSync('npm', ['install', '--ignore-scripts', '--no-save', `${name}@${range}`], {
        cwd: dir,
        stdio: ['ignore', process.stderr, process.stderr],
      });
    } catch {
      // Loader will surface unresolved imports; swallow here.
    }
  }
}

export function findInstalledName(
  dir: string,
  requestedSpec: string,
  depsBefore: Set<string>,
): string | undefined {
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

export function readHostDependencies(dir: string): Set<string> {
  const hostPkg = readPackageJson(join(dir, HOST_PACKAGE_JSON));
  return new Set(Object.keys(hostPkg?.dependencies ?? {}));
}

export function extractNameFromSpec(spec: string): string | undefined {
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

function readPackageJson(path: string):
  | {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
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
