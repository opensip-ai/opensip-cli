/**
 * Canonical duration → human label (ADR-0144).
 *
 * Sub-second: whole milliseconds. Sub-minute: one-decimal seconds via tenths
 * rounding. Minute scale: `"Nm Y.Ys"`.
 *
 * Non-finite and negative inputs fall back to the `0` path (never throw).
 */

/** Sanitize a duration input for display — non-finite / negative → 0. */
function sanitizeMs(ms: number): number {
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/**
 * Format a millisecond duration as `"Xms"` under one second, `"X.Ys"` for
 * sub-minute durations, or `"Xm Y.Ys"` at minute scale.
 *
 * @example formatDuration(450)   // "450ms"
 * @example formatDuration(19850) // "19.9s"
 * @example formatDuration(1471600) // "24m 31.6s"
 */
export function formatDuration(ms: number): string {
  const safe = sanitizeMs(ms);
  // Round before branching: [999.5, 1000) must promote to "1.0s", not "1000ms".
  const wholeMs = Math.round(safe);
  if (wholeMs < 1000) return `${String(wholeMs)}ms`;

  const totalTenths = Math.round(safe / 100);
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;

  const minutes = Math.floor(totalTenths / 600);
  const remainingTenths = totalTenths % 600;
  return `${minutes}m ${(remainingTenths / 10).toFixed(1)}s`;
}
