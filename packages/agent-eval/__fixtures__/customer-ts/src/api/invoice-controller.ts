import { submitInvoice } from '../features/invoice/index.js';

import type { InvoiceInput, InvoiceResult } from '../shared/types.js';

export function handleInvoiceRequest(input: InvoiceInput): InvoiceResult {
  return submitInvoice(input);
}
