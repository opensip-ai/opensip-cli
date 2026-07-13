import { submitInvoice } from './features/invoice/index.js';

export function main(): number {
  return submitInvoice({ subtotalCents: 12_500, customerTier: 'preferred' }).totalCents;
}
