// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Check resolution for fitness recipes
 *
 * Resolves recipe check selectors (explicit, category, pattern, all)
 * into concrete check slug lists using the check registry.
 */

import { SystemError } from '@opensip-tools/core'
import { minimatch } from 'minimatch'

import type { CheckSelector } from './types.js'
import type { CheckRegistry } from '../framework/registry.js'


/**
 * Resolve a CheckSelector to a list of check slugs from the registry.
 */
export function resolveChecks(selector: CheckSelector, registry: CheckRegistry): readonly string[] {
  const allCheckSlugs = registry.listSlugs()

  switch (selector.type) {
    case 'explicit': {
      return resolveExplicitSelector(selector.checkIds, allCheckSlugs, registry)
    }
    case 'pattern': {
      return resolvePatternSelector(selector.include, selector.exclude ?? [], allCheckSlugs, registry)
    }
    case 'tags': {
      return resolveTagsSelector(selector.include, selector.exclude ?? [], registry)
    }
    case 'all': {
      return resolveAllSelector(selector.exclude ?? [], allCheckSlugs, registry)
    }
    default: {
      const _exhaustive: never = selector
      throw new SystemError(`Unknown selector type: ${JSON.stringify(_exhaustive)}`, { code: 'SYSTEM.FITNESS.UNKNOWN_SELECTOR' })
    }
  }
}

function resolveExplicitSelector(
  checkIds: readonly string[],
  allCheckSlugs: readonly string[],
  registry?: CheckRegistry,
): readonly string[] {
  const existingIds = new Set(allCheckSlugs)
  const result: string[] = []

  for (const id of checkIds) {
    // Exact match (works for both namespaced and bare slugs already in registry)
    if (existingIds.has(id)) {
      result.push(id)
      continue
    }
    // Bare slug → try registry resolution (handles namespace lookup)
    if (registry && !id.includes(':')) {
      const check = registry.getBySlug(id)
      if (check) {
        // Find the namespaced key for this check
        const key = allCheckSlugs.find(s => s.endsWith(`:${id}`)) ?? id
        result.push(key)
      }
    }
  }
  return result
}

function buildMatchTargets(slug: string, registry?: CheckRegistry): string[] {
  const targets = [slug]
  // Extract bare slug from namespaced key (e.g., 'builtin:no-eval' → 'no-eval')
  const bareSlug = slug.includes(':') ? slug.split(':').pop()! : slug
  if (bareSlug !== slug) targets.push(bareSlug)

  if (registry) {
    const check = registry.getBySlug(slug)
    if (check?.config.tags) {
      for (const tag of check.config.tags) {
        targets.push(`${tag}/${bareSlug}`)
      }
    }
  }
  return targets
}

function resolvePatternSelector(
  includePatterns: readonly string[],
  excludePatterns: readonly string[],
  allCheckSlugs: readonly string[],
  registry?: CheckRegistry,
): readonly string[] {
  return allCheckSlugs.filter((slug) => {
    const matchTargets = buildMatchTargets(slug, registry)

    const included = includePatterns.some((pattern) =>
      matchTargets.some((target) => minimatch(target, pattern, { nocase: false })),
    )
    if (!included) return false

    const excluded = excludePatterns.some((pattern) =>
      matchTargets.some((target) => minimatch(target, pattern, { nocase: false })),
    )
    return !excluded
  })
}

function resolveTagsSelector(
  includeTags: readonly string[],
  excludeTags: readonly string[],
  registry: CheckRegistry,
): readonly string[] {
  const includeSet = new Set(includeTags)
  const excludeSet = new Set(excludeTags)
  const allSlugs = registry.listSlugs()

  return allSlugs.filter((key) => {
    const check = registry.getBySlug(key)
    if (!check) return false
    const tags = check.config.tags ?? []
    const hasInclude = tags.some((tag) => includeSet.has(tag))
    if (!hasInclude) return false
    const hasExclude = tags.some((tag) => excludeSet.has(tag))
    return !hasExclude
  })
}

function resolveAllSelector(
  excludePatterns: readonly string[],
  allCheckSlugs: readonly string[],
  registry?: CheckRegistry,
): readonly string[] {
  if (excludePatterns.length === 0) return allCheckSlugs

  return allCheckSlugs.filter((slug) => {
    const matchTargets = buildMatchTargets(slug, registry)

    const excluded = excludePatterns.some((pattern) =>
      matchTargets.some((target) => minimatch(target, pattern, { nocase: false })),
    )
    return !excluded
  })
}

/** Result of validating check references against the registry */
interface CheckReferenceValidation {
  valid: string[]
  missing: string[]
}

/** Validate a list of check IDs against known IDs, returning valid and missing sets */
export function validateCheckReferences(
  checkIds: readonly string[],
  allCheckIds: readonly string[],
): CheckReferenceValidation {
  const existingSet = new Set(allCheckIds)
  const valid: string[] = []
  const missing: string[] = []

  for (const id of checkIds) {
    if (existingSet.has(id)) {
      valid.push(id)
    } else {
      missing.push(id)
    }
  }

  return { valid, missing }
}

/** Match check IDs against glob patterns with optional exclusions */
export function matchCheckIds(
  patterns: readonly string[],
  checkIds: readonly string[],
  excludePatterns?: readonly string[],
  registry?: CheckRegistry,
): readonly string[] {
  if (
    !Array.isArray(patterns) ||
    !Array.isArray(checkIds) ||
    (excludePatterns !== undefined && !Array.isArray(excludePatterns))
  ) {
    return []
  }
  return resolvePatternSelector(patterns, excludePatterns ?? [], checkIds, registry)
}
