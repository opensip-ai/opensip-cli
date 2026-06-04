/**
 * @fileoverview Path resolution for opensip-tools project + user state.
 *
 * Per-project state lives at:
 *
 *   <project>/opensip-tools.config.yml          ← TRACKED — project config
 *   <project>/opensip-tools/                    ← TRACKED — user-authored
 *     fit/checks/<*.mjs>                        ← custom fitness checks
 *     fit/recipes/<*.mjs>                       ← custom fitness recipes
 *     sim/scenarios/<*.mjs>                     ← custom sim scenarios
 *     sim/recipes/<*.mjs>                       ← custom sim recipes
 *     .runtime/                                 ← GITIGNORED — runtime state
 *       sessions/                               ← run history
 *       reports/                                ← dashboard HTML
 *       logs/                                   ← structured JSONL logs
 *       datastore.sqlite                        ← sessions, baselines, catalog
 *       cache/                                  ← AST + prewarm caches
 *       plugins/<fit|sim>/node_modules/         ← npm-installed plugins
 *
 *   ~/.opensip-tools/                           ← USER-LEVEL (cross-project)
 *     config.yml                                ← cloud API key, defaults
 *
 * Every consumer (logger, persistence/store, gate, plugin loader,
 * configure command, uninstall command) constructs paths through this
 * resolver instead of using inline string concatenation, so a future
 * change to the layout is a single-file edit.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ToolShortId } from '../tools/ids.js';

// =============================================================================
// PROJECT PATHS
// =============================================================================

/** Per-project paths produced by `resolveProjectPaths(projectDir)`. */
export interface ProjectPaths {
  /** Absolute path to the project root (== input). */
  readonly projectDir: string;
  /** <project>/opensip-tools.config.yml */
  readonly configFile: string;
  /** <project>/opensip-tools — user-authored content root. */
  readonly userSourceDir: string;
  /**
   * `<project>/opensip-tools/<domain>/<kind>` — a tool's user-authored
   * plugin source dir (e.g. `userPluginDir('fit', 'checks')`). Generic
   * over (domain, kind) so the kernel carries no fit/sim vocabulary
   * (ADR-0009 corollary 1); the layout's `userSubdirs` supply the kinds.
   */
  readonly userPluginDir: (domain: string, kind: string) => string;
  /** <project>/opensip-tools/.runtime — gitignored runtime state. */
  readonly runtimeDir: string;
  /** <project>/opensip-tools/.runtime/sessions */
  readonly sessionsDir: string;
  /** <project>/opensip-tools/.runtime/reports */
  readonly reportsDir: string;
  /** <project>/opensip-tools/.runtime/logs */
  readonly logsDir: string;
  /** <project>/opensip-tools/.runtime/cache */
  readonly cacheDir: string;
  /** <project>/opensip-tools/.runtime/cache/graph — graph-tool catalog cache root. */
  readonly graphCacheDir: string;
  /** <project>/opensip-tools/.runtime/plugins/<domain> — npm-installed plugins. */
  readonly pluginsDir: (domain: string) => string;
}

/**
 * Path-resolver domain set for FIRST-PARTY tools — the storage/path
 * discriminator (`'fit' | 'sim' | 'graph'`). Aliased to `ToolShortId`
 * from the central registry (audit-round-3 Finding H) so first-party
 * path/storage sites stay in sync.
 *
 * Note this is tool *identity*, a separate concern from plugin
 * *discovery*: `pluginsDir` / `userPluginDir` take a plain `string` so
 * third-party tools can host project-local plugins without being listed
 * here (ADR-0009 corollary 1).
 */
export type PathDomain = ToolShortId;

/** Resolve the project path layout for a given project directory. */
export function resolveProjectPaths(projectDir: string): ProjectPaths {
  const userSourceDir = join(projectDir, 'opensip-tools');
  const runtimeDir = join(userSourceDir, '.runtime');
  const cacheDir = join(runtimeDir, 'cache');
  const graphCacheDir = join(cacheDir, 'graph');
  return {
    projectDir,
    configFile: join(projectDir, 'opensip-tools.config.yml'),
    userSourceDir,
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

/** User-level paths in `~/.opensip-tools/`. */
export interface UserPaths {
  /** ~/.opensip-tools — root for all user-level state. */
  readonly userHomeDir: string;
  /** ~/.opensip-tools/config.yml — cloud API key + per-user defaults. */
  readonly configFile: string;
  /**
   * ~/.opensip-tools/update-state.json — tool-generated cache of the
   * last-known newer published version, so the "update available" notice can
   * persist across runs instead of showing once. NOT user-authored: written
   * by the update notifier, cleared automatically once the running version
   * catches up. Distinct from `configFile`, which holds user-authored config.
   */
  readonly updateStateFile: string;
}

/** Resolve the user-level path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-tools');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
    updateStateFile: join(userHomeDir, 'update-state.json'),
  };
}
