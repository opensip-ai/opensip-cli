// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file clean-code-naming-quality -- short names used in severity mapping utilities
// @fitness-ignore-file project-readme-existence -- internal module, not a package root
/**
 * @fileoverview Shared severity classification helpers
 *
 * Centralizes severity-based signal filtering and counting logic
 * used across types, framework, and recipes modules.
 */

import type { SignalSeverity } from '@opensip-tools/core'

/** Returns true for 'high' or 'critical' severity signals (error-level) */
export function isErrorSeverity(severity: SignalSeverity): boolean {
  return severity === 'high' || severity === 'critical'
}

/** Returns true for 'medium' severity signals (warning-level) */
export function isWarningSeverity(severity: SignalSeverity): boolean {
  return severity === 'medium'
}

/** Count error-level signals in an array */
export function countErrors(signals: readonly { severity: string }[]): number {
  let count = 0
  for (const s of signals) {
    if (isErrorSeverity(s.severity as SignalSeverity)) count++
  }
  return count
}

/** Count warning-level signals in an array */
export function countWarnings(signals: readonly { severity: string }[]): number {
  let count = 0
  for (const s of signals) {
    if (isWarningSeverity(s.severity as SignalSeverity)) count++
  }
  return count
}
