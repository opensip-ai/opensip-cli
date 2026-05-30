/**
 * @fileoverview Shared presentation formatters.
 *
 * Small, dependency-free helpers used by more than one tool's CLI/report
 * layer. Kept in core because tools sit in a peer layer and cannot depend on
 * each other — core is their only shared home.
 */

/**
 * Format a millisecond duration as `"Xms"` under one second, or `"X.Ys"`
 * (one decimal place) at one second and above.
 *
 * @example formatDuration(450)  // "450ms"
 * @example formatDuration(1500) // "1.5s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
