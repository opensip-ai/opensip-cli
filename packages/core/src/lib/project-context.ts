/**
 * @fileoverview Project-context resolver.
 *
 * Walks up from `cwd` looking for an opensip-tools project (i.e. an
 * ancestor where `resolveProjectConfigPath` would succeed). Returns a
 * single `ProjectContext` carrying everything downstream consumers
 * need: cwd, cwdExplicit, projectRoot, configPath, walkedUp, scope.
 *
 * The walker leans on `resolveProjectConfigPath` at each ancestor so
 * the `package.json#opensip-tools.configPath` pointer is honored
 * everywhere it works at a single directory (matches existing
 * `resolveProjectConfigPath` contract).
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

import { logger } from './logger.js';

const MODULE_TAG = 'core:project-context';

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
  /** `'project'` iff a config was discovered; `'none'` otherwise. */
  readonly scope: 'project' | 'none';
}

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
    return undefined;
  }
}
