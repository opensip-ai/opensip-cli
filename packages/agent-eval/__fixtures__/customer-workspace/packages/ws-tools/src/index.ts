/** Deliberately unrelated package for impact over-selection checks. */
export function formatBuildLabel(value: string): string {
  return `build:${value.trim()}`;
}
