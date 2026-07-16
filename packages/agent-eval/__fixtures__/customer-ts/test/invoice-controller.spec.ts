import { describe, expect, it } from 'vitest';

import { handleInvoiceRequest } from '../src/api/invoice-controller.js';

describe('invoice controller', () => {
  it('returns an invoice result', () => {
    expect(handleInvoiceRequest({ subtotalCents: 500, customerTier: 'standard' }).totalCents).toBe(540);
  });
});
