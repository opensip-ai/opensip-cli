/**
 * Canonical score → human label (ADR-0144).
 *
 * Score *meaning* is owned by `passRate` / upstream aggregates. This only
 * formats a number as `"N%"` with Math.round. Non-finite / negative → `"0%"`.
 * No 0–100 clamp — clamping would hide producer bugs.
 */

/**
 * Format a score number for display.
 *
 * @example formatScore(88)   // "88%"
 * @example formatScore(67.4) // "67%"
 * @example formatScore(NaN)  // "0%"
 */
export function formatScore(score: number): string {
  const n = Number.isFinite(score) && score >= 0 ? Math.round(score) : 0;
  return `${n}%`;
}
