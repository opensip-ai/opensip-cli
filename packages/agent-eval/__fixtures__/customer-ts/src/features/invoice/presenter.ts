import { formatUsd } from '../../shared/currency.js';

import type { InvoiceResult } from '../../shared/types.js';

export function presentInvoice(result: InvoiceResult): string {
  return `Invoice total: ${formatUsd(result.totalCents)}`;
}
