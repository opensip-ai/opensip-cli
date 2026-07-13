import { discountFor } from './discount.js';
import { taxFor } from './tax.js';

import type { InvoiceInput } from '../../shared/types.js';

/** Impact target F for the gold tasks. */
export function calculateInvoice(input: InvoiceInput): number {
  const discounted =
    input.subtotalCents - discountFor(input.subtotalCents, input.customerTier === 'preferred');
  return discounted + taxFor(discounted);
}
