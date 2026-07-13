export function discountFor(subtotalCents: number, preferred: boolean): number {
  return preferred ? Math.round(subtotalCents * 0.05) : 0;
}
