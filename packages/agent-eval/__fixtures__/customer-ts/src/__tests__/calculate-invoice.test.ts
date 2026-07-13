import { describe, expect, it } from 'vitest';

import { calculateInvoice } from '../services/billing/calculate-invoice.js';

function calculateStandardInvoice(): number {
  return calculateInvoice({ subtotalCents: 1_000, customerTier: 'standard' });
}

describe('calculateInvoice', () => {
  it('applies tax to a standard invoice', () => {
    expect(calculateStandardInvoice()).toBe(1_080);
  });
});
