/**
 * @fileoverview Project-local plugin management.
 *
 * Owns the three commands that act on the project-local plugin set
 * declared in `opensip-tools.config.yml`:
 *
 *   plugin sync             — install everything in config, remove stray deps
 *   plugin add <spec>       — add a spec to config + install
 *   plugin remove <name>    — remove from config + uninstall
 *
 * Companion to `plugin.ts` (which owns the user-level `plugin install/
 * list/remove` for `~/.opensip-tools/`). The project-local set is the
 * authoritative list of plugins for THIS repo — checked into git,
 * shared across developers, deterministic in CI. The user-level set
 * is a developer's per-machine scratch space for one-off experiments.
 *
 * Config edits preserve comments and formatting via the `yaml`
 * package's Document API; `js-yaml` would strip those and reflow the
 * file on every save.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  getProjectPluginDir,
  readProjectPluginsList,
  type PluginDomain,
} from '@opensip-tools/core'
import { parseDocument, YAMLSeq, type Scalar } from 'yaml'

import type { PluginResult } from '../types.js'

const CONFIG_FILENAME = 'opensip-tools.config.yml'
const VALID_DOMAINS: ReadonlySet<PluginDomain> = new Set(['fit', 'sim', 'asm'])

/**
 * Guard against npm-argv injection. Specs starting with '-' would be
 * interpreted as flags; anything empty is nonsense. Matches the same
 * predicate in `plugin.ts`.
 */
function isSafeNpmSpec(spec: string): boolean {
  return spec.length > 0 && !spec.startsWith('-')
}

/** Best-effort inference: a spec containing the word `sim` targets sim, else fit. */
function inferDomain(spec: string): PluginDomain {
  if (/\bsim\b/.test(spec)) return 'sim'
  return 'fit'
}

function resolveDomain(override: string | undefined, spec: string): PluginDomain | undefined {
  if (override === undefined) return inferDomain(spec)
  if (VALID_DOMAINS.has(override as PluginDomain)) return override as PluginDomain
  return undefined
}

/**
 * Ensure a package.json exists in the project-local plugin dir so
 * `npm install` has a container. Same stub shape `plugin install`
 * uses for the user-level dir.
 */
function ensurePluginDirSeeded(dir: string, domain: PluginDomain): void {
  mkdirSync(dir, { recursive: true })
  const pkgJsonPath = join(dir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: `opensip-tools-${domain}-plugins`,
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: {},
    }, null, 2) + '\n')
  }
}

/**
 * Strip a version range from an npm spec to get a bare package name.
 * `@scope/pkg@^1.2.3` → `@scope/pkg`; `pkg@latest` → `pkg`; local
 * paths / tarballs return the spec unchanged (caller handles those
 * separately when inspecting node_modules).
 */
function extractPackageName(spec: string): string {
  // Leave paths and tarballs alone.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.endsWith('.tgz')) return spec
  // Scoped: @scope/name[@version] — version is the LAST `@`.
  if (spec.startsWith('@')) {
    const lastAt = spec.lastIndexOf('@')
    return lastAt === 0 ? spec : spec.slice(0, lastAt)
  }
  // Unscoped: name[@version]
  const at = spec.indexOf('@')
  return at === -1 ? spec : spec.slice(0, at)
}

/**
 * Read a config YAML as a mutable Document, preserving comments +
 * formatting for round-tripping. Returns null if the file is missing.
 */
function readConfigDoc(projectDir: string): { path: string; doc: ReturnType<typeof parseDocument> } | null {
  const path = join(projectDir, CONFIG_FILENAME)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8')
  const doc = parseDocument(raw)
  return { path, doc }
}

/**
 * Ensure the config doc has a `plugins` map. If missing, add it with
 * a short header comment explaining its role. Returns the map node.
 */
function ensurePluginsMap(doc: ReturnType<typeof parseDocument>): {
  get: (domain: PluginDomain) => YAMLSeq | undefined
  ensure: (domain: PluginDomain) => YAMLSeq
} {
  let pluginsNode = doc.get('plugins')
  if (pluginsNode == null) {
    doc.set('plugins', doc.createNode({}))
    pluginsNode = doc.get('plugins')
  }

  return {
    get(domain: PluginDomain): YAMLSeq | undefined {
      const seq = (doc.getIn(['plugins', domain]) as YAMLSeq | undefined)
      return seq
    },
    ensure(domain: PluginDomain): YAMLSeq {
      let seq = doc.getIn(['plugins', domain]) as YAMLSeq | undefined
      if (!(seq instanceof YAMLSeq)) {
        const newSeq = new YAMLSeq()
        doc.setIn(['plugins', domain], newSeq)
        seq = doc.getIn(['plugins', domain]) as YAMLSeq
      }
      return seq
    },
  }
}

function saveConfigDoc(path: string, doc: ReturnType<typeof parseDocument>): void {
  writeFileSync(path, doc.toString(), 'utf-8')
}

/**
 * Install a single spec into the project-local dir via `npm install`.
 * Mirrors the peer-dep follow-up from `plugin.ts` so plugins with
 * `peerDependencies` (notably `@opensip-tools/core`) resolve cleanly.
 */
function npmInstall(spec: string, dir: string): void {
  // --ignore-scripts: refuse to execute plugin postinstall/preinstall hooks.
  // Auto-sync runs npm install for every spec declared in the project's
  // opensip-tools.config.yml the first time `fit` runs in a fresh clone.
  // Without this flag, a malicious project config could cause arbitrary code
  // execution at install time, before the user has any chance to inspect.
  execFileSync('npm', ['install', '--ignore-scripts', spec], { cwd: dir, stdio: 'inherit' })
}

function npmUninstall(pkgName: string, dir: string): void {
  execFileSync('npm', ['uninstall', pkgName], { cwd: dir, stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// plugin sync
// ---------------------------------------------------------------------------

/**
 * Install every spec in the project config into the project-local
 * plugin dir. Safe to re-run — it lets `npm install` reconcile to
 * the declared set.
 *
 * When `domainFilter` is provided, only that domain is synced; else
 * all three (fit / sim / asm) are synced.
 */
export async function pluginSync(
  projectDir: string,
  domainFilter?: string,
): Promise<PluginResult> {
  const result = readConfigDoc(projectDir)
  if (!result) {
    return {
      type: 'plugin',
      action: 'sync',
      success: false,
      error: `No ${CONFIG_FILENAME} found at ${projectDir}. Run \`opensip-tools init\` to create one.`,
    }
  }

  const filter = domainFilter === undefined ? undefined : resolveDomain(domainFilter, '')
  if (domainFilter !== undefined && !filter) {
    return {
      type: 'plugin',
      action: 'sync',
      success: false,
      error: `Invalid --domain '${domainFilter}' — expected one of: ${[...VALID_DOMAINS].join(', ')}`,
    }
  }

  const domains: readonly PluginDomain[] = filter ? [filter] : ['fit', 'sim', 'asm']
  let totalInstalled = 0
  for (const domain of domains) {
    const specs = readProjectPluginsList(projectDir, domain)
    if (!specs || specs.length === 0) continue
    for (const spec of specs) {
      if (!isSafeNpmSpec(spec)) continue
    }
    const dir = getProjectPluginDir(projectDir, domain)
    ensurePluginDirSeeded(dir, domain)
    for (const spec of specs) {
      if (!isSafeNpmSpec(spec)) continue
      npmInstall(spec, dir)
      totalInstalled++
    }
  }

  return {
    type: 'plugin',
    action: 'sync',
    success: true,
    syncedCount: totalInstalled,
  }
}

// ---------------------------------------------------------------------------
// plugin add
// ---------------------------------------------------------------------------

/**
 * Append a spec to `plugins.<domain>` in config AND install it into
 * the project-local dir. Idempotent — duplicate adds are coalesced.
 */
export async function pluginAdd(
  spec: string,
  projectDir: string,
  domainOverride?: string,
): Promise<PluginResult> {
  if (!isSafeNpmSpec(spec)) {
    return { type: 'plugin', action: 'add', packageName: spec, success: false, error: `Invalid spec '${spec}' — must not start with '-'` }
  }
  const domain = resolveDomain(domainOverride, spec)
  if (!domain) {
    return { type: 'plugin', action: 'add', packageName: spec, success: false, error: `Invalid --domain '${String(domainOverride)}'` }
  }

  const loaded = readConfigDoc(projectDir)
  if (!loaded) {
    return { type: 'plugin', action: 'add', packageName: spec, success: false, error: `No ${CONFIG_FILENAME} found at ${projectDir}. Run \`opensip-tools init\` first.` }
  }
  const { path, doc } = loaded
  const plugins = ensurePluginsMap(doc)
  const seq = plugins.ensure(domain)

  // Idempotent — avoid duplicate entries.
  const existing = seq.items
    .map((item) => (item as Scalar).value)
    .filter((v): v is string => typeof v === 'string')
  if (!existing.includes(spec)) {
    seq.add(spec)
    saveConfigDoc(path, doc)
  }

  // Install into the project-local dir regardless — covers the case
  // where the config already listed the spec but node_modules is stale.
  const dir = getProjectPluginDir(projectDir, domain)
  ensurePluginDirSeeded(dir, domain)
  npmInstall(spec, dir)

  return { type: 'plugin', action: 'add', packageName: spec, success: true }
}

// ---------------------------------------------------------------------------
// plugin remove
// ---------------------------------------------------------------------------

/**
 * Remove a spec from `plugins.<domain>` in config AND uninstall it
 * from the project-local dir. Matches by extracted package name so
 * the caller can pass either `@scope/pkg` or `@scope/pkg@^1.2.3`.
 */
export async function pluginRemoveFromConfig(
  spec: string,
  projectDir: string,
  domainOverride?: string,
): Promise<PluginResult> {
  if (!isSafeNpmSpec(spec)) {
    return { type: 'plugin', action: 'remove', packageName: spec, success: false, error: `Invalid spec '${spec}'` }
  }
  const domain = resolveDomain(domainOverride, spec)
  if (!domain) {
    return { type: 'plugin', action: 'remove', packageName: spec, success: false, error: `Invalid --domain '${String(domainOverride)}'` }
  }

  const loaded = readConfigDoc(projectDir)
  if (!loaded) {
    return { type: 'plugin', action: 'remove', packageName: spec, success: false, error: `No ${CONFIG_FILENAME} found at ${projectDir}.` }
  }
  const { path, doc } = loaded
  const seq = doc.getIn(['plugins', domain]) as YAMLSeq | undefined
  if (seq instanceof YAMLSeq) {
    const targetName = extractPackageName(spec)
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const item = seq.items[i] as Scalar
      const value = typeof item?.value === 'string' ? item.value : ''
      if (extractPackageName(value) === targetName) {
        seq.delete(i)
      }
    }
    saveConfigDoc(path, doc)
  }

  const pkgName = extractPackageName(spec)
  const dir = getProjectPluginDir(projectDir, domain)
  if (existsSync(join(dir, 'node_modules', pkgName))) {
    try {
      npmUninstall(pkgName, dir)
    } catch {
      // If npm uninstall fails (e.g. already gone), silently proceed.
      // The config mutation above is the source of truth.
    }
  }

  return { type: 'plugin', action: 'remove', packageName: spec, success: true }
}
