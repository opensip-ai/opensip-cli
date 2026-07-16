import { priceInvoice } from '../../services/billing/index.js';

import type { InvoiceInput, InvoiceResult } from '../../shared/types.js';

export function runInvoiceWorkflow(input: InvoiceInput): InvoiceResult {
  return { totalCents: priceInvoice(input), currency: 'USD' };
}
