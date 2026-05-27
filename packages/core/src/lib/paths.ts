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
  /** <project>/opensip-tools/fit/checks — custom check definitions. */
  readonly fitChecksDir: string;
  /** <project>/opensip-tools/fit/recipes — custom fitness recipes. */
  readonly fitRecipesDir: string;
  /** <project>/opensip-tools/sim/scenarios — custom scenario definitions. */
  readonly simScenariosDir: string;
  /** <project>/opensip-tools/sim/recipes — custom sim recipes. */
  readonly simRecipesDir: string;
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
  readonly pluginsDir: (domain: PluginsPathDomain) => string;
}

/**
 * Path-resolver domain set — tools whose plugins land in project
 * paths. Intentionally narrower than `core/plugins`'s `PluginDomain`
 * (`'fit' | 'sim' | 'asm' | 'lang'`); 'asm' is reserved for a future
 * tool, and 'lang' adapters install via package deps not
 * project-local plugin dirs.
 *
 * `'graph'` is included so graph-tool can persist per-project cache +
 * baseline state under `.runtime/cache/graph/` and (later) load
 * project-local rule plugins from `.runtime/plugins/graph/`.
 */
export type PathDomain = 'fit' | 'sim' | 'graph';

/**
 * Domain set accepted by `pluginsDir`. Wider than `PathDomain` because
 * `core/plugins/discover` calls it with a value typed `PluginDomain`
 * (`'fit' | 'sim' | 'asm' | 'lang'`); `'asm'` and `'lang'` will not
 * actually reach `pluginsDir` today (the discover function returns
 * empty for them before constructing a path), but typing the union
 * here removes a `as 'fit' | 'sim'` cast at the call site and keeps
 * the type system honest if a third tool lands.
 */
export type PluginsPathDomain = PathDomain | 'asm' | 'lang';

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
    fitChecksDir: join(userSourceDir, 'fit', 'checks'),
    fitRecipesDir: join(userSourceDir, 'fit', 'recipes'),
    simScenariosDir: join(userSourceDir, 'sim', 'scenarios'),
    simRecipesDir: join(userSourceDir, 'sim', 'recipes'),
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
}

/** Resolve the user-level path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-tools');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
  };
}
