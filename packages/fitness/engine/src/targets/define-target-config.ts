/**
 * @fileoverview defineTargetConfig — typed API for project target configuration
 *
 * Used in opensip.targets.ts to define targets and per-check target overrides
 * with full TypeScript type safety.
 */

import type { TargetConfigInput } from './types.js'

/**
 * Define the project's target configuration with type safety.
 *
 * @example
 * ```typescript
 * import { defineTargetConfig } from '@opensip-tools/core/targets'
 *
 * export default defineTargetConfig({
 *   targets: {
 *     backend: {
 *       description: 'Backend packages and services',
 *       include: ['packages/* /src/** /*.ts', 'services/* /src/** /*.ts'],
 *       exclude: ['** /*.test.ts', '** /__tests__/**'],
 *       tags: ['production', 'node'],
 *     },
 *     frontend: {
 *       description: 'Dashboard React app',
 *       include: ['apps/dashboard/src/** /*.tsx'],
 *       exclude: ['** /*.test.tsx'],
 *       tags: ['production', 'react'],
 *     },
 *   },
 * })
 * ```
 */
export function defineTargetConfig<T extends TargetConfigInput>(config: T): T {
  return config
}
