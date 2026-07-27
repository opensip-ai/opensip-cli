/**
 * @fileoverview Project-context resolver.
 *
 * Walks up from `cwd` looking first for an initialized opensip-cli project,
 * then for the nearest strong repository/workspace root. Returns a single
 * `ProjectContext` carrying everything downstream consumers need: cwd,
 * cwdExplicit, projectRoot, configPath, walkedUp, scope.
 *
 * The walker leans on `resolveProjectConfigPath` at each ancestor so explicit
 * `--config` and canonical root `opensip-cli.config.yml` resolution stay
 * consistent with the rest of the config-loading surface.
 *
 * Strict `--config` semantics: when the caller passes `explicitConfigPath`
 * and `resolveProjectConfigPath` rejects it at the starting ancestor,
 * the resolver propagates the underlying `ToolError` rather than
 * silently walking up. Silently walking up would let `--config /typo.yml`
 * land on some unrelated ancestor's config — exactly the surprise this
 * module exists to prevent. Implicit ancestor discovery still swallows
 * "no config at this directory" errors (that's the walking signal).
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { resolveProjectConfigPath } from '../config-resolution.js';

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { isToolErrorLike } from './errors.js';
import { logger } from './logger.js';

const MODULE_TAG = 'core:project-context';
const MAX_ROOT_MARKER_BYTES = 64 * 1024;

export type ProjectContextScope = 'project' | 'ephemeral' | 'none';

/** Resolved per-invocation project context — read by every downstream consumer. */
export interface ProjectContext {
  /** Literal cwd at invocation (or the value of an explicit `--cwd` flag). Absolute. */
  readonly cwd: string;
  /** True when the user passed `--cwd` on the command line (vs Commander defaulting it). */
  readonly cwdExplicit: boolean;
  /**
   * Canonical project root. If an ancestor has a config file, that ancestor.
   * Otherwise the nearest strong repository/workspace root, or `cwd` when no
   * such root exists.
   */
  readonly projectRoot: string;
  /** Resolved config file path at `projectRoot`, or undefined when no project was found. */
  readonly configPath: string | undefined;
  /** Ancestor steps walked from `cwd` to `projectRoot`. 0 when cwd is the root. */
  readonly walkedUp: number;
  /**
   * Project scope for this invocation.
   *
   * - `project`: a real config file was discovered or supplied.
   * - `ephemeral`: the CLI synthesized a no-init config document.
   * - `none`: no project context is available.
   */
  readonly scope: ProjectContextScope;
  /** Synthetic config document used for no-init ephemeral runs. */
  readonly ephemeralConfigDocument?: unknown;
}

/** Input to {@link resolveProjectContext}: cwd plus optional overrides controlling discovery. */
export interface ResolveProjectContextInput {
  /** Literal cwd or `--cwd` value. */
  readonly cwd: string;
  /** True when `--cwd` was passed on the command line. */
  readonly cwdExplicit: boolean;
  /**
   * Optional `--config <path>` override. Honored at the *start* ancestor only.
   * Strict: if provided and the path doesn't resolve, the resolver throws.
   */
  readonly explicitConfigPath?: string;
  /**
   * Absolute path beyond which the walker stops. Used by tests to prevent the
   * walker from escaping fixture directories and finding the real repo's config
   * above. Defaults to the filesystem root.
   */
  readonly stopAt?: string;
}

/**
 * Resolve the project context for an invocation. Pure function — no side
 * effects beyond debug logging.
 *
 * @throws {ToolError} when `explicitConfigPath` is provided and
 * `resolveProjectConfigPath` rejects it at the starting ancestor.
 */
export function resolveProjectContext(input: ResolveProjectContextInput): ProjectContext {
  const cwd = resolve(input.cwd);
  const start = canonicalDirectory(input.cwd);
  const stop = input.stopAt ? canonicalDirectory(input.stopAt) : null;
  let dir = start;
  let prev = '';
  let walkedUp = 0;
  let uninitializedRoot: { readonly path: string; readonly walkedUp: number } | undefined;

  while (dir !== prev) {
    const explicit = walkedUp === 0 ? input.explicitConfigPath : undefined;
    const configPath = tryResolveConfig(dir, explicit);
    if (configPath) {
      logger.debug({
        evt: 'project.root.resolved',
        module: MODULE_TAG,
        cwd: start,
        projectRoot: dir,
        configPath,
        walkedUp,
      });
      return {
        cwd,
        cwdExplicit: input.cwdExplicit,
        projectRoot: dir,
        configPath,
        walkedUp,
        scope: 'project',
      };
    }
    if (uninitializedRoot === undefined && isStrongProjectRoot(dir)) {
      uninitializedRoot = { path: dir, walkedUp };
    }
    if (stop && dir === stop) break;
    prev = dir;
    dir = dirname(dir);
    walkedUp++;
  }

  if (uninitializedRoot !== undefined) {
    logger.debug({
      evt: 'project.root.uninitialized-resolved',
      module: MODULE_TAG,
      cwd: start,
      projectRoot: uninitializedRoot.path,
      walkedUp: uninitializedRoot.walkedUp,
    });
    return {
      cwd,
      cwdExplicit: input.cwdExplicit,
      projectRoot: uninitializedRoot.path,
      configPath: undefined,
      walkedUp: uninitializedRoot.walkedUp,
      scope: 'none',
    };
  }

  logger.debug({
    evt: 'project.root.not-found',
    module: MODULE_TAG,
    cwd: start,
    walkedTo: dir,
  });
  return {
    cwd,
    cwdExplicit: input.cwdExplicit,
    projectRoot: start,
    configPath: undefined,
    walkedUp: 0,
    scope: 'none',
  };
}

/**
 * Canonicalize existing directory aliases without requiring the path to exist.
 * The fallback preserves the previous absolute-path behavior for callers that
 * use a not-yet-created Init target.
 */
function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * The one discovery outcome that means "keep walking up", as a registered definition rather
 * than a message pattern. Bound once at module load so a typo is a load-time failure.
 */
const CONFIG_NOT_FOUND = coreErrorCatalog.require('CORE.CONFIG.NOT_FOUND');

/** True for fixed marker names whose filesystem type is itself authoritative. */
function hasFileSystemMarker(
  dir: string,
  name: string,
  kinds: readonly ('file' | 'dir')[],
): boolean {
  try {
    const stat = lstatSync(join(dir, name));
    return (
      (kinds.includes('file') && stat.isFile()) || (kinds.includes('dir') && stat.isDirectory())
    );
  } catch {
    // @swallow-ok Missing or unreadable optional markers do not establish a project root.
    return false;
  }
}

/** Git accepts a directory/file marker reached through a filesystem symlink. */
function hasGitMarker(dir: string): boolean {
  const markerPath = join(dir, '.git');
  try {
    const marker = lstatSync(markerPath);
    if (marker.isFile() || marker.isDirectory()) return true;
    if (!marker.isSymbolicLink()) return false;
    const target = lstatSync(realpathSync(markerPath));
    return target.isFile() || target.isDirectory();
  } catch {
    // @swallow-ok An unresolved Git marker cannot establish a project root.
    return false;
  }
}

/**
 * Read at most `limit` bytes. Opening and reading through the descriptor avoids
 * a stat/read race turning a supposedly bounded root probe into an unbounded
 * allocation.
 */
function readBoundedUtf8(path: string, limit = MAX_ROOT_MARKER_BYTES): string | undefined {
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
    // @swallow-ok Unreadable optional root metadata is treated as absent.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // @swallow-ok Read-only discovery preserves the already selected root.
        // Read-only discovery is best effort; a failed close cannot change the
        // selected root and must not turn discovery into a project mutation.
      }
    }
  }
}

function hasPackageWorkspaces(dir: string): boolean {
  const raw = readBoundedUtf8(join(dir, 'package.json'));
  if (raw === undefined) return false;
  try {
    const parsed = JSON.parse(raw) as { readonly workspaces?: unknown };
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) return true;
    if (typeof workspaces !== 'object' || workspaces === null) return false;
    return Array.isArray((workspaces as { readonly packages?: unknown }).packages);
  } catch {
    // @swallow-ok Invalid optional package metadata is not a workspace marker.
    return false;
  }
}

function hasCargoWorkspace(dir: string): boolean {
  const raw = readBoundedUtf8(join(dir, 'Cargo.toml'));
  if (raw === undefined) return false;
  return /^\s*\[workspace\]\s*(?:#.*)?$/mu.test(raw);
}

/** The closed, side-effect-free root-marker rule for uninitialized projects. */
function isStrongProjectRoot(dir: string): boolean {
  return (
    hasGitMarker(dir) ||
    hasFileSystemMarker(dir, '.hg', ['dir']) ||
    hasFileSystemMarker(dir, 'pnpm-workspace.yaml', ['file']) ||
    hasFileSystemMarker(dir, 'go.work', ['file']) ||
    hasPackageWorkspaces(dir) ||
    hasCargoWorkspace(dir)
  );
}

/** True only for initialized projects backed by a real config file. */
export function isInitializedProjectContext(
  project: ProjectContext | undefined,
): project is ProjectContext & {
  readonly scope: 'project';
  readonly configPath: string;
} {
  return project?.scope === 'project' && project.configPath !== undefined;
}

/** True only for no-init project contexts backed by a synthetic document. */
export function isEphemeralProjectContext(
  project: ProjectContext | undefined,
): project is ProjectContext & {
  readonly scope: 'ephemeral';
  readonly ephemeralConfigDocument: unknown;
} {
  return project?.scope === 'ephemeral' && project.ephemeralConfigDocument !== undefined;
}

/** True when the context has a runtime storage root. */
export function hasRuntimeProjectContext(
  project: ProjectContext | undefined,
): project is ProjectContext & { readonly scope: 'project' | 'ephemeral' } {
  return project?.scope === 'project' || project?.scope === 'ephemeral';
}

/**
 * Wrap `resolveProjectConfigPath` so a throw at an ancestor during
 * implicit walking is just "no config here." When the caller passed
 * `--config <path>`, an unresolvable path is a USER ERROR and must
 * propagate — silently walking up would land on the wrong config.
 *
 * WHY THIS SWITCHES ON A CODE AND NOT ON THE MESSAGE
 * It used to test `/No .*? found\. Checked:/` against `error.message`. That made a
 * user-facing English string load-bearing for control flow: rewording it — something a
 * translator, a copy edit, or a message-length bound would do without a second thought —
 * silently converts implicit ancestor discovery into a hard failure, or the reverse, with
 * every test still passing. The registered code is the stable contract.
 */
function tryResolveConfig(dir: string, explicit: string | undefined): string | undefined {
  try {
    const resolved = resolveProjectConfigPath(dir, explicit);
    return existsSync(resolved) ? resolved : undefined;
  } catch (error) {
    if (explicit !== undefined) throw error;
    // Only swallow the terminal "no config discovered at this root after all
    // attempts". This allows upward walking when a directory simply has no
    // OpenSIP config. Propagate other resolution problems.
    if (isToolErrorLike(error) && error.code === CONFIG_NOT_FOUND.code) {
      return undefined;
    }
    throw error;
  }
}
