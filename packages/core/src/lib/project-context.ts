/**
 * @fileoverview Project-context resolver.
 *
 * Walks up from `cwd` looking for an opensip-cli project (i.e. an
 * ancestor where `resolveProjectConfigPath` would succeed). Returns a
 * single `ProjectContext` carrying everything downstream consumers
 * need: cwd, cwdExplicit, projectRoot, configPath, walkedUp, scope.
 *
 * The walker leans on `resolveProjectConfigPath` at each ancestor so explicit
 * `--config` and canonical root `opensip-cli.config.yml` resolution stay
 * consistent with the rest of the config-loading surface.
 *
 * Strict `--config` semantics: when the caller passes `explicitConfigPath`
 * and `resolveProjectConfigPath` rejects it at the starting ancestor,
 * the resolver propagates the underlying `ValidationError` rather than
 * silently walking up. Silently walking up would let `--config /typo.yml`
 * land on some unrelated ancestor's config — exactly the surprise this
 * module exists to prevent. Implicit ancestor discovery still swallows
 * "no config at this directory" errors (that's the walking signal).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveProjectConfigPath } from '../config-resolution.js';

import { ValidationError } from './errors.js';
import { logger } from './logger.js';

const MODULE_TAG = 'core:project-context';

export type ProjectContextScope = 'project' | 'ephemeral' | 'none';

/** Resolved per-invocation project context — read by every downstream consumer. */
export interface ProjectContext {
  /** Literal cwd at invocation (or the value of an explicit `--cwd` flag). Absolute. */
  readonly cwd: string;
  /** True when the user passed `--cwd` on the command line (vs Commander defaulting it). */
  readonly cwdExplicit: boolean;
  /**
   * Resolved project root. If an ancestor has a config file, that ancestor.
   * Otherwise equals `cwd` (no discovery; commands like `init` fall back to here).
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
 * @throws {ValidationError} when `explicitConfigPath` is provided and
 * `resolveProjectConfigPath` rejects it at the starting ancestor.
 */
export function resolveProjectContext(input: ResolveProjectContextInput): ProjectContext {
  const start = resolve(input.cwd);
  const stop = input.stopAt ? resolve(input.stopAt) : null;
  let dir = start;
  let prev = '';
  let walkedUp = 0;

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
        cwd: start,
        cwdExplicit: input.cwdExplicit,
        projectRoot: dir,
        configPath,
        walkedUp,
        scope: 'project',
      };
    }
    if (stop && dir === stop) break;
    prev = dir;
    dir = dirname(dir);
    walkedUp++;
  }

  logger.debug({
    evt: 'project.root.not-found',
    module: MODULE_TAG,
    cwd: start,
    walkedTo: dir,
  });
  return {
    cwd: start,
    cwdExplicit: input.cwdExplicit,
    projectRoot: start,
    configPath: undefined,
    walkedUp: 0,
    scope: 'none',
  };
}

/** True only for initialized projects backed by a real config file. */
export function isInitializedProjectContext(
  project: ProjectContext | undefined,
): project is ProjectContext & { readonly scope: 'project'; readonly configPath: string } {
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
    if (error instanceof ValidationError && /No .*? found\. Checked:/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}
