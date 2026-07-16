import { calculateInvoice } from '../services/billing/calculate-invoice.js';

export function repriceInvoice(subtotalCents: number): number {
  return calculateInvoice({ subtotalCents, customerTier: 'preferred' });
}
