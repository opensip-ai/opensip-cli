import { quoteTotal } from './quote-total.js';

export function quoteOrder(subtotalCents: number): number {
  return quoteTotal(subtotalCents);
}
