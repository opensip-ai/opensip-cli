/**
 * @fileoverview Path resolution for opensip-tools project + user state.
 *
 * v3.0.0 introduces a per-project state model:
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
 *       baseline.sarif                          ← architecture-gate baseline
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
 *
 * v2 paths (legacy) are also exposed for the migration command and
 * the deprecated-fallback-with-notice behavior in the plugin loader.
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
  /** <project>/opensip-tools/.runtime/baseline.sarif (default gate baseline). */
  readonly baselinePath: string;
  /** <project>/opensip-tools/.runtime/plugins/<domain> — npm-installed plugins. */
  readonly pluginsDir: (domain: PathDomain) => string;
  /**
   * Marker file written after a successful v2→v3 migration. Presence
   * means migration ran already; the auto-migrator skips when it
   * exists, so the migration runs at most once per project.
   */
  readonly migrationMarker: string;
}

/**
 * Path-resolver domain set — the two tools whose plugins land in
 * project paths. Intentionally narrower than `core/plugins`'s
 * 4-element `PluginDomain` (`'fit' | 'sim' | 'asm' | 'lang'`); 'asm'
 * is reserved for a future tool, and 'lang' adapters install via
 * package deps not project-local plugin dirs.
 */
export type PathDomain = 'fit' | 'sim';

/** Resolve the v3 project path layout for a given project directory. */
export function resolveProjectPaths(projectDir: string): ProjectPaths {
  const userSourceDir = join(projectDir, 'opensip-tools');
  const runtimeDir = join(userSourceDir, '.runtime');
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
    cacheDir: join(runtimeDir, 'cache'),
    baselinePath: join(runtimeDir, 'baseline.sarif'),
    pluginsDir: (domain) => join(runtimeDir, 'plugins', domain),
    migrationMarker: join(runtimeDir, 'migrated-from-v2'),
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

/** Resolve the v3 user-level path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-tools');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
  };
}

// =============================================================================
// LEGACY (v2) PATHS — used only by the migration command.
// =============================================================================

/**
 * v2 paths — exposed exclusively for the migration command and the
 * deprecated-fallback notice in the plugin loader. New code MUST NOT
 * reference these.
 */
export interface LegacyV2Paths {
  /** v2: <project>/.opensip-tools — old project-local plugin dir. */
  readonly projectV2Dir: string;
  /** v2: <project>/.opensip-tools/fit */
  readonly projectV2FitDir: string;
  /** v2: <project>/.opensip-tools/sim */
  readonly projectV2SimDir: string;
  /** v2: <project>/.opensip-tools/baseline.sarif */
  readonly projectV2BaselinePath: string;
  /** v2: ~/.opensip-tools/sessions — was the global session store. */
  readonly userV2SessionsDir: string;
  /** v2: ~/.opensip-tools/reports */
  readonly userV2ReportsDir: string;
  /** v2: ~/.opensip-tools/logs */
  readonly userV2LogsDir: string;
  /** v2: ~/.opensip-tools/<domain> — was the global user-plugin dir. */
  readonly userV2PluginDir: (domain: PathDomain) => string;
}

export function resolveLegacyV2Paths(projectDir: string): LegacyV2Paths {
  const projectV2Dir = join(projectDir, '.opensip-tools');
  const userV2HomeDir = join(homedir(), '.opensip-tools');
  return {
    projectV2Dir,
    projectV2FitDir: join(projectV2Dir, 'fit'),
    projectV2SimDir: join(projectV2Dir, 'sim'),
    projectV2BaselinePath: join(projectV2Dir, 'baseline.sarif'),
    userV2SessionsDir: join(userV2HomeDir, 'sessions'),
    userV2ReportsDir: join(userV2HomeDir, 'reports'),
    userV2LogsDir: join(userV2HomeDir, 'logs'),
    userV2PluginDir: (domain) => join(userV2HomeDir, domain),
  };
}
