// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Target file resolver
 *
 * Expands target glob patterns to concrete file paths,
 * deduplicating across multiple targets.
 */

import { resolve } from 'node:path'

import { globSync } from 'glob'

import type { Target } from './types.js'

/**
 * Resolve multiple targets to a deduplicated list of file paths.
 *
 * Expands include globs, filters out exclude globs, and deduplicates
 * across all targets so no file is processed twice.
 *
 * @param targets - Targets to resolve
 * @param rootDir - Project root for glob resolution
 * @returns Sorted, deduplicated array of absolute file paths
 */
export function resolveTargetFiles(targets: readonly Target[], rootDir: string): string[] {
  const files = new Set<string>()

  for (const target of targets) {
    const { include, exclude } = target.config

    for (const pattern of include) {
      const matches = globSync(pattern, {
        cwd: rootDir,
        ignore: [...exclude],
        absolute: true,
      })
      for (const match of matches) {
        files.add(resolve(match))
      }
    }
  }

  return [...files].sort()
}
