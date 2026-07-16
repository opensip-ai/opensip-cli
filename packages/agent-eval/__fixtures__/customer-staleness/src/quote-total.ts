/** Stable target for the binary catalog-staleness evaluation. */
export function quoteTotal(subtotalCents: number): number {
  return subtotalCents + 8;
}
