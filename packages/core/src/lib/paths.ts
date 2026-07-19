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
 *       artifacts/<tool>/                       ← host-owned raw scanner artifacts
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
import { join, resolve } from 'node:path';

import { resolveGenerationDigest, sha256PathIdentity } from './ephemeral-project-generation.js';
import { resolveUserPaths } from './user-paths.js';

import type { BundledToolShortId } from '../tools/ids.js';

export { isPathInside, toPosixRelative } from './path-containment.js';
export {
  RUNTIME_PROMOTION_JOURNAL_FILE,
  USER_UNINSTALL_RECEIPT_FILE,
  resolveCoordinationPaths,
  resolveUserPaths,
  type CoordinationPaths,
  type UserPaths,
} from './user-paths.js';

// =============================================================================
// PROJECT PATHS
// =============================================================================

/** Host-owned runtime-state subtree, whether project-local or ephemeral. */
export interface RuntimePaths {
  /** Root runtime directory. */
  readonly runtimeDir: string;
  /** Runtime sessions directory. */
  readonly sessionsDir: string;
  /** Runtime reports directory. */
  readonly reportsDir: string;
  /** Runtime logs directory. */
  readonly logsDir: string;
  /** Host-owned raw scanner artifact store. */
  readonly artifactsDir: string;
  /** Per-tool artifact directory. */
  readonly artifactDir: (tool: string) => string;
  /** Runtime cache directory. */
  readonly cacheDir: string;
  /** Graph-tool catalog cache root. */
  readonly graphCacheDir: string;
}

/** Per-project paths produced by `resolveProjectPaths(projectDir)`. */
export interface ProjectPaths extends RuntimePaths {
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
  /** <project>/opensip-cli/.runtime/plugins/<domain> — npm-installed plugins. */
  readonly pluginsDir: (domain: string) => string;
}

/** Runtime paths for a no-init ephemeral project. */
export interface EphemeralProjectPaths extends RuntimePaths {
  /** Canonical absolute project root whose no-init runtime this cache entry belongs to. */
  readonly projectDir: string;
  /** Generation-bound when reliable pre-existing filesystem facts are available. */
  readonly cacheKey: string;
  /** Canonical-path-only key shared by all generations at this location. */
  readonly coordinationKey: string;
  /** Strength of the cache key's repository-generation claim. */
  readonly identityStrength: EphemeralProjectIdentityStrength;
  /** Internal digest of the canonical root. Never expose in customer output. */
  readonly canonicalRootDigest: string;
  /** Internal digest of reliable root/gitdir facts, when available. */
  readonly generationDigest?: string;
}

/** Strength available for a current ephemeral cache storage key. */
export type EphemeralProjectIdentityStrength = 'generation-bound' | 'path-only';

/**
 * Internal cache identity. Paths and digests are intentionally suitable for
 * host coordination/markers only; customer-facing projections must omit them.
 */
export interface EphemeralProjectIdentity {
  readonly projectDir: string;
  readonly coordinationKey: string;
  readonly cacheKey: string;
  readonly identityStrength: EphemeralProjectIdentityStrength;
  readonly canonicalRootDigest: string;
  readonly generationDigest?: string;
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

function buildRuntimePaths(runtimeDir: string): RuntimePaths {
  const cacheDir = join(runtimeDir, 'cache');
  const graphCacheDir = join(cacheDir, 'graph');
  const artifactsDir = join(runtimeDir, 'artifacts');
  return {
    runtimeDir,
    sessionsDir: join(runtimeDir, 'sessions'),
    reportsDir: join(runtimeDir, 'reports'),
    logsDir: join(runtimeDir, 'logs'),
    artifactsDir,
    artifactDir: (tool) => join(artifactsDir, tool),
    cacheDir,
    graphCacheDir,
  };
}

/** Resolve the project path layout for a given project directory. */
export function resolveProjectPaths(projectDir: string): ProjectPaths {
  const userSourceDir = join(projectDir, 'opensip-cli');
  const runtimePaths = buildRuntimePaths(join(userSourceDir, '.runtime'));
  return {
    ...runtimePaths,
    projectDir,
    configFile: join(projectDir, 'opensip-cli.config.yml'),
    userSourceDir,
    authoredToolsDir: join(userSourceDir, 'tools'),
    userPluginDir: (domain, kind) => join(userSourceDir, domain, kind),
    pluginsDir: (domain) => join(runtimePaths.runtimeDir, 'plugins', domain),
  };
}

function canonicalProjectDir(projectDir: string): string {
  const absolute = resolve(projectDir);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Canonical-path-only key used to serialize all generations at one location. */
export function projectCoordinationKey(projectDir: string): string {
  return sha256PathIdentity(canonicalProjectDir(projectDir)).slice(0, 24);
}

/**
 * Cache key used before generation-bound identities existed. It remains an
 * explicit lookup seam so status/Init/uninstall can classify old entries
 * without confusing this path-only identity with current generation proof.
 */
export function legacyEphemeralProjectCacheKey(projectDir: string): string {
  return projectCoordinationKey(projectDir);
}

/**
 * Resolve the current no-init cache identity exclusively from pre-existing
 * canonical-root and stable filesystem facts. Mutable workspace manifests are
 * deliberately absent, so normal editor atomic saves never rotate the cache.
 */
export function resolveEphemeralProjectIdentity(projectDir: string): EphemeralProjectIdentity {
  const canonical = canonicalProjectDir(projectDir);
  const canonicalRootDigest = sha256PathIdentity(canonical);
  const coordinationKey = canonicalRootDigest.slice(0, 24);
  const generationDigest = resolveGenerationDigest(canonical);
  if (generationDigest === undefined) {
    return {
      projectDir: canonical,
      coordinationKey,
      cacheKey: coordinationKey,
      identityStrength: 'path-only',
      canonicalRootDigest,
    };
  }
  return {
    projectDir: canonical,
    coordinationKey,
    cacheKey: sha256PathIdentity(
      `opensip-ephemeral-cache-v2\0${canonicalRootDigest}\0${generationDigest}`,
    ).slice(0, 24),
    identityStrength: 'generation-bound',
    canonicalRootDigest,
    generationDigest,
  };
}

/** Current user-cache storage key for a project's no-init runtime directory. */
export function ephemeralProjectCacheKey(projectDir: string): string {
  return resolveEphemeralProjectIdentity(projectDir).cacheKey;
}

/** Resolve the no-init runtime path layout for a project directory. */
export function resolveEphemeralProjectPaths(projectDir: string): EphemeralProjectPaths {
  const identity = resolveEphemeralProjectIdentity(projectDir);
  return {
    ...buildRuntimePaths(join(resolveUserPaths().ephemeralProjectsDir, identity.cacheKey)),
    ...identity,
  };
}

/**
 * THE seam for "where does this run's runtime state live?" — project-local when
 * the project is initialized, user-cache when it is ephemeral (no-init).
 *
 * Every consumer of runtime state (datastore, logs, reports, artifacts, caches)
 * MUST route through here rather than calling `resolveProjectPaths` directly,
 * or an ephemeral run silently writes into the user's repository — which is
 * exactly the promise a no-init first run makes: it writes nothing to your
 * project. `report` did precisely that until this seam existed.
 *
 * Structural parameter (not `ProjectContext`) to keep `paths` free of a
 * dependency on `project-context`.
 */
export function resolveRuntimePathsForScope(project: {
  readonly scope: 'project' | 'ephemeral' | 'none';
  readonly projectRoot: string;
}): RuntimePaths {
  return project.scope === 'ephemeral'
    ? resolveEphemeralProjectPaths(project.projectRoot)
    : resolveProjectPaths(project.projectRoot);
}
