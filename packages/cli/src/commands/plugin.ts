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
import {
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  type Document as YAMLDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

import type { PluginInfo, PluginResult, SyncEntry } from '@opensip-tools/contracts';

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
 * Edit the project's `plugins.<domain>` list via the `yaml`
 * Document API. Round-trips comments, ordering, and surrounding
 * whitespace (the regex-driven line edits this replaces could not
 * — they reformatted the file silently when seeing a quoted key or
 * an unusual indent). A malformed document fails closed: the edit
 * is skipped and a structured error is thrown so the caller can
 * surface a clear "your config is broken" message.
 */
function editPluginList(
  configPath: string,
  domain: PathDomain,
  name: string,
  op: 'add' | 'remove',
): boolean {
  if (!existsSync(configPath)) {
    if (op === 'remove') return false;
    // No config to edit — write a minimal one.
    writeFileSync(
      configPath,
      `plugins:\n  ${domain}:\n    - "${name}"\n`,
      'utf8',
    );
    return true;
  }

  const text = readFileSync(configPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? 'unknown YAML error';
    throw new Error(
      `Cannot edit plugins.${domain} in ${configPath}: ${first}. ` +
      `Fix the syntax error and re-run.`,
    );
  }

  const root = doc.contents;
  if (root === null) {
    if (op === 'remove') return false;
    // Empty doc — write a fresh `plugins:` map.
    writeFileSync(
      configPath,
      `plugins:\n  ${domain}:\n    - "${name}"\n`,
      'utf8',
    );
    return true;
  }

  // The top-level node must be a YAML map. A scalar / sequence at
  // the root means the file isn't an opensip-tools config — refuse
  // to edit rather than reformat the whole thing.
  if (!isMap(root)) {
    throw new Error(
      `Cannot edit plugins.${domain} in ${configPath}: top-level node is not a mapping. ` +
      `opensip-tools.config.yml must start with a YAML map.`,
    );
  }

  if (op === 'add') {
    return appendToPluginList(doc, root, domain, name, configPath);
  }
  return removeFromPluginList(doc, root, domain, name, configPath);
}

function appendToPluginList(
  doc: YAMLDocument,
  root: YAMLMap,
  domain: PathDomain,
  name: string,
  configPath: string,
): boolean {
  let plugins = root.get('plugins');
  if (!isMap(plugins)) {
    plugins = doc.createNode({});
    root.set('plugins', plugins);
  }
  const pluginsMap = plugins as YAMLMap;

  let list = pluginsMap.get(domain);
  if (!isSeq(list)) {
    list = doc.createNode([]);
    pluginsMap.set(domain, list);
  }
  const seq = list as YAMLSeq;

  // Idempotent — first occurrence wins.
  for (const item of seq.items) {
    const value = isScalar(item) ? item.value : item;
    if (value === name) return false;
  }
  seq.add(name);
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

function removeFromPluginList(
  doc: YAMLDocument,
  root: YAMLMap,
  domain: PathDomain,
  name: string,
  configPath: string,
): boolean {
  const plugins = root.get('plugins');
  if (!isMap(plugins)) return false;
  const list = plugins.get(domain);
  if (!isSeq(list)) return false;

  const before = list.items.length;
  list.items = list.items.filter((item) => {
    const value = isScalar(item) ? item.value : item;
    return value !== name;
  });
  if (list.items.length === before) return false;
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

function addToConfigPluginList(configPath: string, domain: PathDomain, name: string): boolean {
  return editPluginList(configPath, domain, name, 'add');
}

function removeFromConfigPluginList(configPath: string, domain: PathDomain, name: string): boolean {
  return editPluginList(configPath, domain, name, 'remove');
}

/**
 * Test-only export for the YAML-driven config edit so unit tests can
 * exercise the round-trip behaviour without spawning npm. Intentionally
 * not part of the public CLI API surface.
 */
export const __test = { editPluginList };

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

  const plugins: PluginInfo[] = [];

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
  const domain = resolveDomain(domainOverride, packageName);
  if (!domain) {
    return {
      type: 'plugin-add',
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

  const domain = resolveDomain(domainOverride, packageName);
  if (!domain) {
    return {
      type: 'plugin-remove',
      packageName,
      success: false,
      error: `Invalid --domain '${String(domainOverride)}' — expected one of: ${[...VALID_DOMAINS].join(', ')}`,
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
      execFileSync('npm', ['install', '--ignore-scripts', '--no-save', `${name}@${range}`], {
        cwd: dir,
        stdio: ['ignore', process.stderr, process.stderr],
      });
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

