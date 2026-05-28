/**
 * Resolve user-supplied positional paths to validated absolute paths
 * for `opensip-tools graph`. No glob expansion (the shell handles
 * globs); no workspace-name shortcut (D10). Throws ConfigurationError
 * on the first invalid input.
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { ConfigurationError, logger } from '@opensip-tools/core'

const MODULE_GRAPH_CLI = 'graph:cli'

/**
 * Resolve user-supplied positional paths to validated absolute paths.
 *
 * Each input must be a path to an existing directory (file paths are
 * deferred). Relative paths resolve against `cwd`. Throws
 * `ConfigurationError` on the first invalid input.
 *
 * Returns paths in the original argument order.
 */
export function resolvePositionalPaths(
  paths: readonly string[],
  cwd: string,
): readonly string[] {
  const out: string[] = []
  for (const p of paths) {
    const trimmed = p.trim()
    if (trimmed.length === 0) {
      throw new ConfigurationError('Positional path is empty.')
    }
    const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
    if (!existsSync(abs)) {
      throw new ConfigurationError(`Path does not exist: '${p}' (resolved to ${abs}).`)
    }
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      /* v8 ignore next */
      throw new ConfigurationError(`Path is not readable: '${p}' (${abs}).`)
    }
    if (!isDir) {
      throw new ConfigurationError(
        `Path is not a directory: '${p}'. graph accepts directories only.`,
      )
    }
    out.push(abs)
  }
  logger.info({
    evt: 'graph.cli.scope.positional',
    module: MODULE_GRAPH_CLI,
    count: out.length,
  })
  return out
}

/**
 * Produce a short display label for an absolute path — relative to
 * `process.cwd()` when meaningfully shorter, otherwise the absolute
 * path. Used in user-facing error messages and reports.
 */
export function positionalPathLabel(absPath: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, absPath)
  if (rel.length === 0) return '.'
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
  return absPath
}
