// @fitness-ignore-file project-readme-existence -- internal module, not a package root
/**
 * @fileoverview Shared severity and category mapping for fitness checks
 *
 * Maps FindingSeverity to SignalSeverity and check category strings
 * to SignalCategory. Used by defineCheck and PatternDetector.
 */

import { logger } from '@opensip-tools/core'

import type { FindingSeverity } from '../types/findings.js'
import type { SignalSeverity, SignalCategory } from '@opensip-tools/core'


/** Map FindingSeverity to SignalSeverity */
export function mapFindingSeverity(severity: FindingSeverity): SignalSeverity {
  switch (severity) {
    case 'error': {
      return 'high'
    }
    case 'warning': {
      return 'medium'
    }
    default: {
      return 'medium'
    }
  }
}

/**
 * Tag → category lookup table. Frozen to make accidental mutation
 * impossible. The original 7-arm switch translated literally into this
 * record; ordering of categories doesn't matter (the iteration walks
 * the input tag list, not the table).
 *
 * The `quality` → `warning` mapping mirrors the pre-table fallback:
 * "this is a low-severity quality concern, surface it as a warning."
 */
const TAG_TO_CATEGORY: Readonly<Record<string, SignalCategory>> = Object.freeze({
  security: 'security',
  performance: 'performance',
  architecture: 'architecture',
  quality: 'warning',
  resilience: 'resilience',
  testing: 'testing',
  documentation: 'documentation',
})

const KNOWN_CATEGORY_TAGS = new Set(Object.keys(TAG_TO_CATEGORY))

/**
 * Tags we have already warned about. Avoids spamming the warn channel
 * for the same misspelled tag on every check that carries it. Cleared
 * implicitly on process restart.
 */
const warnedUnknownTagSets = new Set<string>()

function maybeWarnUnknownTags(tags: readonly string[]): void {
  if (tags.length === 0) return
  const hasKnown = tags.some((tag) => KNOWN_CATEGORY_TAGS.has(tag))
  if (hasKnown) return

  const sorted = [...tags].sort()
  const key = sorted.join(',')
  if (warnedUnknownTagSets.has(key)) return
  warnedUnknownTagSets.add(key)

  logger.warn({
    evt: 'fitness.severity_mapping.unknown_tags',
    module: 'fitness:framework',
    msg: 'check tags do not include any known signal category — falling back to "warning"',
    tags: sorted,
    knownCategoryTags: [...KNOWN_CATEGORY_TAGS].sort(),
  })
}

/** Map check tags to SignalCategory (first matching tag wins) */
export function mapTagsToSignalCategory(tags: readonly string[]): SignalCategory {
  for (const tag of tags) {
    const category = TAG_TO_CATEGORY[tag]
    if (category !== undefined) return category
  }
  maybeWarnUnknownTags(tags)
  return 'warning'
}
