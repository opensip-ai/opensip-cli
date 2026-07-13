import { describe, expect, it } from 'vitest';

import { submitInvoice } from '../src/features/invoice/index.js';

describe('invoice workflow', () => {
  it('submits a preferred invoice through the public barrel', () => {
    expect(submitInvoice({ subtotalCents: 2_000, customerTier: 'preferred' }).currency).toBe('USD');
  });
});
