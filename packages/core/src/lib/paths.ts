/**
 * @fileoverview Path resolution for opensip-cli project + user state.
 *
 * Per-project state lives at:
 *
 *   <project>/opensip-cli.config.yml          ← TRACKED — project config
 *   <project>/opensip-cli/                    ← TRACKED — user-authored
 *     fit/checks/<*.mjs>                        ← custom fitness checks
 *     fit/recipes/<*.mjs>                       ← custom fitness recipes
 *     sim/scenarios/<*.mjs>                     ← custom sim scenarios
 *     sim/recipes/<*.mjs>                       ← custom sim recipes
 *     tools/<name>/opensip-tool.manifest.json   ← TRACKED authored Tool
 *                                                 (whole subcommand; the
 *                                                 project-local analogue of
 *                                                 fit/checks + sim/scenarios —
 *                                                 lives BESIDE fit/sim, NOT
 *                                                 under .runtime/;
 *                                                 deny-by-default)
 *     .runtime/                                 ← GITIGNORED — runtime state
 *       sessions/                               ← run history
 *       reports/                                ← dashboard HTML
 *       logs/                                   ← structured JSONL logs
 *       datastore.sqlite                        ← sessions, baselines, catalog
 *       cache/                                  ← AST + prewarm caches
 *       plugins/<fit|sim>/node_modules/         ← npm-installed plugins
 *
 *   ~/.opensip-cli/                           ← USER-LEVEL (cross-project)
 *     config.yml                                ← cloud API key, defaults
 *     plugins/tool/node_modules/                ← user-global Tool plugins
 *                                                 (whole subcommands;
 *                                                 available in every project)
 *     tools/<name>/opensip-tool.manifest.json   ← user-global authored Tool
 *                                                 (trusted-by-default authored
 *                                                 sidecar; the `npm i -g`
 *                                                 analogue for authored code)
 *
 * Every consumer (logger, persistence/store, gate, plugin loader,
 * configure command, uninstall command) constructs paths through this
 * resolver instead of using inline string concatenation, so a future
 * change to the layout is a single-file edit.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import type { BundledToolShortId } from '../tools/ids.js';

// =============================================================================
// PROJECT PATHS
// =============================================================================

/** Per-project paths produced by `resolveProjectPaths(projectDir)`. */
export interface ProjectPaths {
  /** Absolute path to the project root (== input). */
  readonly projectDir: string;
  /** <project>/opensip-cli.config.yml */
  readonly configFile: string;
  /** <project>/opensip-cli — user-authored content root. */
  readonly userSourceDir: string;
  /**
   * `<project>/opensip-cli/tools` — TRACKED authored Tool sidecars (the
   * whole-subcommand analogue of fit/checks + sim/scenarios). Each child is
   * a `<name>/opensip-tool.manifest.json` sidecar. Lives BESIDE `fit/` and
   * `sim/`, NOT under `.runtime/`; deny-by-default at admission.
   */
  readonly authoredToolsDir: string;
  /**
   * `<project>/opensip-cli/<domain>/<kind>` — a tool's user-authored
   * plugin source dir (e.g. `userPluginDir('fit', 'checks')`). Generic
   * over (domain, kind) so the kernel carries no fit/sim vocabulary
   * (ADR-0009 corollary 1); the layout's `userSubdirs` supply the kinds.
   */
  readonly userPluginDir: (domain: string, kind: string) => string;
  /** <project>/opensip-cli/.runtime — gitignored runtime state. */
  readonly runtimeDir: string;
  /** <project>/opensip-cli/.runtime/sessions */
  readonly sessionsDir: string;
  /** <project>/opensip-cli/.runtime/reports */
  readonly reportsDir: string;
  /** <project>/opensip-cli/.runtime/logs */
  readonly logsDir: string;
  /** <project>/opensip-cli/.runtime/cache */
  readonly cacheDir: string;
  /** <project>/opensip-cli/.runtime/cache/graph — graph-tool catalog cache root. */
  readonly graphCacheDir: string;
  /** <project>/opensip-cli/.runtime/plugins/<domain> — npm-installed plugins. */
  readonly pluginsDir: (domain: string) => string;
}

/**
 * Path-resolver domain set for FIRST-PARTY tools — the storage/path
 * discriminator (`'fit' | 'sim' | 'graph'`). Aliased to
 * `BundledToolShortId` from the central registry (audit-round-3 Finding
 * H) so first-party path/storage sites stay in sync. This stays the
 * CLOSED bundled union even after the M3 widening of the open session
 * `ToolShortId`: the project path layout only knows the bundled tool
 * directories, so type-safety here is correct.
 *
 * Note this is tool *identity*, a separate concern from plugin
 * *discovery*: `pluginsDir` / `userPluginDir` take a plain `string` so
 * third-party tools can host project-local plugins without being listed
 * here (ADR-0009 corollary 1).
 */
export type PathDomain = BundledToolShortId;

/** Resolve the project path layout for a given project directory. */
export function resolveProjectPaths(projectDir: string): ProjectPaths {
  const userSourceDir = join(projectDir, 'opensip-cli');
  const runtimeDir = join(userSourceDir, '.runtime');
  const cacheDir = join(runtimeDir, 'cache');
  const graphCacheDir = join(cacheDir, 'graph');
  return {
    projectDir,
    configFile: join(projectDir, 'opensip-cli.config.yml'),
    userSourceDir,
    authoredToolsDir: join(userSourceDir, 'tools'),
    userPluginDir: (domain, kind) => join(userSourceDir, domain, kind),
    runtimeDir,
    sessionsDir: join(runtimeDir, 'sessions'),
    reportsDir: join(runtimeDir, 'reports'),
    logsDir: join(runtimeDir, 'logs'),
    cacheDir,
    graphCacheDir,
    pluginsDir: (domain) => join(runtimeDir, 'plugins', domain),
  };
}

// =============================================================================
// USER PATHS
// =============================================================================

/** User-level paths in `~/.opensip-cli/`. */
export interface UserPaths {
  /** ~/.opensip-cli — root for all user-level state. */
  readonly userHomeDir: string;
  /** ~/.opensip-cli/config.yml — cloud API key + per-user defaults. */
  readonly configFile: string;
  /**
   * `~/.opensip-cli/plugins/<domain>` — user-global (cross-project)
   * npm-installed plugins. Used today by the `tool` domain: a Tool plugin
   * is a whole subcommand, so a user-global install makes it available in
   * every project (like `npm i -g`), unlike fit/sim packs which are
   * project-committed. Generic over domain for symmetry with
   * `ProjectPaths.pluginsDir`.
   */
  readonly pluginsDir: (domain: string) => string;
  /**
   * `~/.opensip-cli/tools` — global authored Tool sidecars
   * (trusted-by-default). Each child is a
   * `<name>/opensip-tool.manifest.json` sidecar. The user placed it in
   * their own home dir → admitted without an allowlist (the `npm i -g`
   * analogue for authored code).
   */
  readonly authoredToolsDir: string;
  /**
   * ~/.opensip-cli/update-state.json — tool-generated cache of the
   * last-known newer published version, so the "update available" notice can
   * persist across runs instead of showing once. NOT user-authored: written
   * by the update notifier, cleared automatically once the running version
   * catches up. Distinct from `configFile`, which holds user-authored config.
   */
  readonly updateStateFile: string;
}

/** Resolve the user-level path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-cli');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
    updateStateFile: join(userHomeDir, 'update-state.json'),
    authoredToolsDir: join(userHomeDir, 'tools'),
    pluginsDir: (domain) => join(userHomeDir, 'plugins', domain),
  };
}

// =============================================================================
// SAFE PATH CONTAINMENT
// =============================================================================

/**
 * Returns true iff `child`, after resolving symlinks via realpath, is the same
 * path as `parent` or located inside it (native-separator prefix match after
 * realpath). Returns false on any error (missing, unresolvable, permission, etc).
 *
 * Canonical helper for preventing path escape / symlink traversal in glob
 * results, plugin discovery, targeting, etc. See also the cli-realpath-validation
 * fitness check that enforces use of realpath-based containment over naive
 * `.startsWith`.
 */
export function isPathInside(child: string, parent: string): boolean {
  let realChild: string;
  let realParent: string;
  try {
    realChild = realpathSync(child);
    realParent = realpathSync(parent);
  } catch {
    // @swallow-ok realpathSync throws when a path does not exist; fail closed (treat as "not inside")
    return false;
  }
  if (realChild === realParent) return true;
  return realChild.startsWith(realParent + sep);
}

/**
 * Normalize a path to project-relative POSIX form: absolute paths are made
 * relative to `cwd`, and OS separators are converted to `/`. Shared by the git
 * changed-file resolver and `graph impact` so both compare paths against
 * catalog occurrences in one canonical form (ADR-0085).
 */
export function toPosixRelative(cwd: string, filePath: string): string {
  const normalized = normalize(filePath);
  if (isAbsolute(normalized)) {
    return relative(cwd, normalized).split(sep).join('/');
  }
  return normalized.split(sep).join('/');
}
