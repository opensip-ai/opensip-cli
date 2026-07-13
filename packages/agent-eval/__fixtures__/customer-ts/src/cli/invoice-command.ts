import { submitInvoice } from '../features/invoice/index.js';
import { presentInvoice } from '../features/invoice/presenter.js';

export function runInvoiceCommand(subtotalCents: number): string {
  return presentInvoice(submitInvoice({ subtotalCents, customerTier: 'standard' }));
}
