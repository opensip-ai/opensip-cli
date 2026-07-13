export function taxFor(subtotalCents: number): number {
  return Math.round(subtotalCents * 0.08);
}
