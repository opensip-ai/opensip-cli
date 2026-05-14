// @fitness-ignore-file project-readme-existence -- internal module, not a package root
/**
 * @fileoverview Shared constants for the fitness framework
 */

/**
 * Standard exclusion patterns for file matching across the framework.
 * Used by execution context, directive inventory, and file cache.
 */
export const DEFAULT_EXCLUSION_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/coverage/**',
  '**/*.tsbuildinfo',
] as const
