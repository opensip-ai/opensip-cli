// @fitness-ignore-file project-readme-existence -- internal module, not a package root
/**
 * @fileoverview Shared severity and category mapping for fitness checks
 *
 * Maps FindingSeverity to SignalSeverity and check category strings
 * to SignalCategory. Used by defineCheck and PatternDetector.
 */

import type { SignalSeverity, SignalCategory } from '@opensip-tools/core'

import type { FindingSeverity } from '../types/findings.js'

/** Map FindingSeverity to SignalSeverity */
export function mapFindingSeverity(severity: FindingSeverity): SignalSeverity {
  switch (severity) {
    case 'error':
      return 'high'
    case 'warning':
      return 'medium'
    default:
      return 'medium'
  }
}

/** Map check tags to SignalCategory (first matching tag wins) */
export function mapTagsToSignalCategory(tags: readonly string[]): SignalCategory {
  for (const tag of tags) {
    switch (tag) {
      case 'security':
        return 'security'
      case 'performance':
        return 'performance'
      case 'architecture':
        return 'architecture'
      case 'quality':
        return 'warning'
      case 'resilience':
        return 'resilience'
      case 'testing':
        return 'testing'
      case 'documentation':
        return 'documentation'
    }
  }
  return 'warning'
}
