import { runInvoiceWorkflow } from './workflow.js';

import type { InvoiceInput, InvoiceResult } from '../../shared/types.js';

export { runInvoiceWorkflow };
export { presentInvoice } from './presenter.js';

export function submitInvoice(input: InvoiceInput): InvoiceResult {
  return runInvoiceWorkflow(input);
}
