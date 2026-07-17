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

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { SystemError } from './errors.js';

import type { BundledToolShortId } from '../tools/ids.js';

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

// =============================================================================
// USER PATHS
// =============================================================================

/** User-level paths in `~/.opensip-cli/`. */
export interface UserPaths {
  /** ~/.opensip-cli — root for all user-level state. */
  readonly userHomeDir: string;
  /** ~/.opensip-cli/config.yml — cloud API key + per-user defaults. */
  readonly configFile: string;
  /** ~/.opensip-cli/cache — user-level tool-generated cache state. */
  readonly cacheDir: string;
  /** ~/.opensip-cli/cache/ephemeral — no-init per-project runtime roots. */
  readonly ephemeralProjectsDir: string;
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

/** Fixed per-project Init promotion journal basename. */
export const RUNTIME_PROMOTION_JOURNAL_FILE = 'runtime-promotion.json';

/** Fixed user-uninstall recovery receipt basename. */
export const USER_UNINSTALL_RECEIPT_FILE = 'user-uninstall.json';

/** Stable paths used only for runtime coordination, never customer evidence. */
export interface CoordinationPaths {
  /** Sibling of `~/.opensip-cli`; user uninstall must never recursively remove it. */
  readonly coordinationDir: string;
  /** Short-lived global mutex used only while publishing coordination transitions. */
  readonly globalMutexFile: string;
  /** Bounded FIFO writer queue and monotonic sequence record. */
  readonly stateFile: string;
  /** Container for path-stable canonical project coordination keys. */
  readonly projectsDir: string;
  /** Shared user-state reader records. */
  readonly userReadersDir: string;
  /** Fixed external user-uninstall recovery receipt. */
  readonly userUninstallReceiptFile: string;
  /** Resolve the fixed, non-generation-bound layout for one coordination key. */
  readonly forProject: (coordinationKey: string) => {
    readonly projectCoordinationDir: string;
    readonly readersDir: string;
    readonly promotionJournalFile: string;
  };
}

/** Resolve the user-level path layout. */
export function resolveUserPaths(): UserPaths {
  const userHomeDir = join(homedir(), '.opensip-cli');
  const cacheDir = join(userHomeDir, 'cache');
  return {
    userHomeDir,
    configFile: join(userHomeDir, 'config.yml'),
    cacheDir,
    ephemeralProjectsDir: join(cacheDir, 'ephemeral'),
    updateStateFile: join(userHomeDir, 'update-state.json'),
    authoredToolsDir: join(userHomeDir, 'tools'),
    pluginsDir: (domain) => join(userHomeDir, 'plugins', domain),
  };
}

/**
 * Resolve the small coordination-only sibling root.
 *
 * This root deliberately lives outside `~/.opensip-cli/`: global uninstall can
 * move or remove the user-data tree, but it must not remove and recreate the
 * mutex that prevents another process from entering that tree concurrently.
 */
export function resolveCoordinationPaths(): CoordinationPaths {
  const coordinationDir = join(homedir(), '.opensip-cli-coordination');
  const projectsDir = join(coordinationDir, 'projects');
  return {
    coordinationDir,
    globalMutexFile: join(coordinationDir, 'coordination.lock'),
    stateFile: join(coordinationDir, 'state.json'),
    projectsDir,
    userReadersDir: join(coordinationDir, 'user-readers'),
    userUninstallReceiptFile: join(coordinationDir, USER_UNINSTALL_RECEIPT_FILE),
    forProject: (coordinationKey) => {
      if (!/^[a-f0-9]{24}$/u.test(coordinationKey)) {
        throw new SystemError('Runtime coordination key is invalid', {
          code: 'SYSTEM.RUNTIME_COORDINATION.INVALID_KEY',
        });
      }
      const projectCoordinationDir = join(projectsDir, coordinationKey);
      return {
        projectCoordinationDir,
        readersDir: join(projectCoordinationDir, 'readers'),
        promotionJournalFile: join(projectCoordinationDir, RUNTIME_PROMOTION_JOURNAL_FILE),
      };
    },
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical-path-only key used to serialize all generations at one location. */
export function projectCoordinationKey(projectDir: string): string {
  return sha256(canonicalProjectDir(projectDir)).slice(0, 24);
}

/**
 * Cache key used before generation-bound identities existed. It remains an
 * explicit lookup seam so status/Init/uninstall can classify old entries
 * without confusing this path-only identity with current generation proof.
 */
export function legacyEphemeralProjectCacheKey(projectDir: string): string {
  return projectCoordinationKey(projectDir);
}

interface StableDirectoryFact {
  readonly role: 'root' | 'gitdir';
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs?: string;
}

function stableDirectoryFact(
  path: string,
  role: StableDirectoryFact['role'],
): StableDirectoryFact | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) return undefined;
    return {
      role,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      ...(stat.birthtimeNs > 0n ? { birthtimeNs: stat.birthtimeNs.toString() } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Read a small gitfile without allowing an atomic replacement to grow the read. */
function readBoundedGitFile(path: string): string | undefined {
  const limit = 4096;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return bytesRead > limit ? undefined : buffer.toString('utf8', 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Identity discovery is read-only and degrades to the root fact.
      }
    }
  }
}

type GitDirectoryResolution =
  | { readonly status: 'absent' }
  | { readonly status: 'resolved'; readonly path: string }
  | { readonly status: 'unreliable' };

function resolveGitDirectory(projectDir: string): GitDirectoryResolution {
  const dotGit = join(projectDir, '.git');
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      try {
        return { status: 'resolved', path: realpathSync(dotGit) };
      } catch {
        return { status: 'unreliable' };
      }
    }
    if (!stat.isFile()) return { status: 'unreliable' };
  } catch (error) {
    return isMissingPathError(error) ? { status: 'absent' } : { status: 'unreliable' };
  }

  const raw = readBoundedGitFile(dotGit);
  const match = raw?.match(/^\s*gitdir:\s*(.+?)\s*$/iu);
  if (match?.[1] === undefined || match[1].includes('\0')) return { status: 'unreliable' };
  const candidate = isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]);
  try {
    return { status: 'resolved', path: realpathSync(candidate) };
  } catch {
    return { status: 'unreliable' };
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function resolveGenerationDigest(projectDir: string): string | undefined {
  const root = stableDirectoryFact(projectDir, 'root');
  if (root === undefined) return undefined;

  const gitDirectory = resolveGitDirectory(projectDir);
  if (gitDirectory.status === 'unreliable') return undefined;
  if (gitDirectory.status === 'absent') {
    return sha256(`opensip-project-generation-v1\0${JSON.stringify([root])}`);
  }
  const gitdir = stableDirectoryFact(gitDirectory.path, 'gitdir');
  if (gitdir === undefined) return undefined;
  const facts = [root, gitdir];
  return sha256(`opensip-project-generation-v1\0${JSON.stringify(facts)}`);
}

/**
 * Resolve the current no-init cache identity exclusively from pre-existing
 * canonical-root and stable filesystem facts. Mutable workspace manifests are
 * deliberately absent, so normal editor atomic saves never rotate the cache.
 */
export function resolveEphemeralProjectIdentity(projectDir: string): EphemeralProjectIdentity {
  const canonical = canonicalProjectDir(projectDir);
  const canonicalRootDigest = sha256(canonical);
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
    cacheKey: sha256(
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
