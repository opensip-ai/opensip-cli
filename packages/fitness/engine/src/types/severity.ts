// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file clean-code-naming-quality -- short names used in severity mapping utilities
/**
 * @fileoverview Shared severity classification helpers
 *
 * Centralizes severity-based signal filtering and counting logic
 * used across types, framework, and recipes modules.
 */

import { isErrorSeverity } from '@opensip-cli/core';

import type { SignalSeverity } from '@opensip-cli/core';

/** Returns true for 'medium' severity signals (warning-level) */
function isWarningSeverity(severity: SignalSeverity): boolean {
  return severity === 'medium';
}

/** Count error-level signals in an array */
export function countErrors(signals: readonly { severity: string }[]): number {
  let count = 0;
  for (const s of signals) {
    if (isErrorSeverity(s.severity as SignalSeverity)) count++;
  }
  return count;
}

/** Count warning-level signals in an array */
export function countWarnings(signals: readonly { severity: string }[]): number {
  let count = 0;
  for (const s of signals) {
    if (isWarningSeverity(s.severity as SignalSeverity)) count++;
  }
  return count;
}
