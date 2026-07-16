import { calculateInvoice } from './calculate-invoice.js';

import type { InvoiceInput } from '../../shared/types.js';

export { calculateInvoice };
export { discountFor } from './discount.js';
export { taxFor } from './tax.js';

export function priceInvoice(input: InvoiceInput): number {
  return calculateInvoice(input);
}
