/**
 * formatDuration — compact ms→human duration used by the shared run-summary and
 * live-progress renderers. Extracted from run-summary.tsx so both consumers share
 * one definition (cli-ui cannot import `@opensip-cli/core`'s formatDuration —
 * the package depends on ink/react only).
 *
 * Format: `<1000ms → "Nms"`, sub-minute durations as `"N.Ys"` (one decimal),
 * and minute-scale durations as `"Nm Y.Ys"`. Long stages render as e.g.
 * "24m 31.6s" so graph runs that spend many minutes in a stage remain easy to
 * scan.
 */
// @fitness-ignore-file duplicate-utility-functions -- intentional: cli-ui is deliberately ink/react-only (see docstring above) and must not depend on @opensip-cli/core, so this small formatter is duplicated by design rather than shared across the layer boundary.
// @graph-ignore-next-line graph:near-duplicate-function-body -- cli-ui intentionally keeps this tiny formatter local to preserve its ink/react-only dependency boundary.
export function formatDuration(ms: number): string {
  // Round to whole milliseconds: the host RunTimer reports fractional ms
  // (performance.now()), and an unrounded sub-second value would print as
  // e.g. "639.6488329999999ms". Every duration surface flows through here, so
  // rounding once keeps them all consistent.
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalTenths = Math.round(ms / 100);
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}s`;

  const minutes = Math.floor(totalTenths / 600);
  const remainingTenths = totalTenths % 600;
  return `${minutes}m ${(remainingTenths / 10).toFixed(1)}s`;
}
