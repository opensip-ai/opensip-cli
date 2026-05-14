/**
 * @fileoverview Core type definitions for fitness checks
 *
 * Check interface is the return type of defineCheck.
 * CheckConfig represents the internal configuration structure.
 * CheckResult carries Signal[].
 */

import type { CheckResult, ItemType } from '../types/findings.js'

import type { CheckScope, ResolvedScope } from './check-config.js'
import type { ExecutionContext, RunOptions } from './execution-context.js'
import type { PathMatcher } from './path-matcher.js'

export type { ResolvedScope }

/**
 * Check configuration options.
 */
export interface CheckConfig {
  readonly id: string
  readonly slug: string
  readonly tags: readonly string[]
  readonly description: string
  readonly longDescription?: string | undefined
  readonly analysisMode: 'analyze' | 'analyzeAll' | 'command'
  readonly scope: ResolvedScope
  readonly itemType: ItemType
  readonly unit?: string | undefined
  readonly additionalExcludes?: readonly string[] | undefined
  readonly docs?: string | undefined
  readonly disabled?: boolean | undefined
  readonly confidence?: 'high' | 'medium' | 'low' | undefined
  readonly timeout?: number | undefined
  readonly scansFiles?: boolean | undefined
  readonly fileTypes?: readonly string[] | undefined
  /** Portable scope declaration for marketplace-ready target matching. */
  readonly checkScope?: CheckScope | undefined
  readonly execute: (ctx: ExecutionContext) => Promise<CheckResult>
}

/**
 * A defined check, ready to run.
 */
export interface Check {
  readonly config: CheckConfig
  readonly run: (cwd: string, options?: RunOptions) => Promise<CheckResult>
  readonly getScope: () => ResolvedScope
  readonly getMatcher: (cwd: string) => PathMatcher
}

/**
 * Type guard: is this value a Check object?
 *
 * Checks for the shape of a Check object:
 * - Has a `config` property that is an object
 * - config has an `id` property that is a string
 * - config has a `slug` property that is a string
 * - config has an `execute` property that is a function
 * - Has a `run` property that is a function
 */
export function isCheck(value: unknown): value is Check {
  if (value === null || typeof value !== 'object') return false

  const obj = value as Record<string, unknown>
  if (!obj.config || typeof obj.config !== 'object') return false

  const config = obj.config as Record<string, unknown>
  if (typeof config.id !== 'string') return false
  if (typeof config.slug !== 'string') return false
  if (typeof config.execute !== 'function') return false
  if (typeof obj.run !== 'function') return false

  return true
}
