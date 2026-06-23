/**
 * @fileoverview Shared presentation formatters.
 *
 * Small, dependency-free helpers used by more than one tool's CLI/report
 * layer. Kept in core because tools sit in a peer layer and cannot depend on
 * each other — core is their only shared home.
 */

/**
 * Format a millisecond duration as `"Xms"` under one second, `"X.Ys"` for
 * sub-minute durations, or `"Xm Y.Ys"` at minute scale.
 *
 * Sub-second values are rounded to whole milliseconds — callers pass
 * fractional `performance.now()` deltas, and an unrounded value would print as
 * e.g. "639.6488329999999ms".
 *
 * @example formatDuration(450)  // "450ms"
 * @example formatDuration(639.64) // "640ms"
 * @example formatDuration(1500) // "1.5s"
 * @example formatDuration(1471600) // "24m 31.6s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;

  const totalTenths = Math.round(ms / 100);
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;

  const minutes = Math.floor(totalTenths / 600);
  const remainingTenths = totalTenths % 600;
  return `${minutes}m ${(remainingTenths / 10).toFixed(1)}s`;
}
