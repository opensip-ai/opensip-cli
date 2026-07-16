import { calculateInvoice } from '../services/billing/calculate-invoice.js';

import type { InvoiceInput } from '../shared/types.js';

const handlers: Readonly<Record<string, (input: InvoiceInput) => number>> = {
  'invoice.total': calculateInvoice,
};

/** Name-based dispatch deliberately hides the target behind a registry lookup. */
export function dispatchInvoiceHandler(name: string, input: InvoiceInput): number {
  const handler = handlers[name];
  if (handler === undefined) throw new Error(`Unknown invoice handler: ${name}`);
  return handler(input);
}
