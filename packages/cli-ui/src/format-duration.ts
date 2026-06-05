/**
 * formatDuration — compact ms→human duration used by the shared run-summary and
 * live-progress renderers. Extracted from run-summary.tsx so both consumers share
 * one definition (cli-ui cannot import `@opensip-tools/core`'s formatDuration —
 * the package depends on ink/react only).
 *
 * Format: `<1000ms → "Nms"`, otherwise `"N.Ys"` (one decimal). Long stages render
 * as e.g. "33.6s"; this intentionally does not roll over to minutes (the simple
 * seconds form is fine for the live view's stage timings).
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
