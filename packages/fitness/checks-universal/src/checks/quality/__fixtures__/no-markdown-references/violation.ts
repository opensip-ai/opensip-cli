// See docs/architecture/overview.md for the full design rationale.
export function total(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}
