/** Dynamic module loading is intentionally isolated behind a runtime boundary. */
export async function loadPaymentReference(invoiceId: string): Promise<string> {
  const paymentClient = await import('../generated/payment-client.js');
  return paymentClient.generatedPaymentReference(invoiceId);
}
