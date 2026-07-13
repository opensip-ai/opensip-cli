export interface InvoiceInput {
  readonly subtotalCents: number;
  readonly customerTier: 'standard' | 'preferred';
}

export interface InvoiceResult {
  readonly totalCents: number;
  readonly currency: 'USD';
}
