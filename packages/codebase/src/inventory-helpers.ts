export const CONTROL_CHARACTER = /\p{Cc}/u;
export const INVENTORY_CANCELLED_REASON = 'inventory-cancelled';
export const INVENTORY_BATCH_SIZE = 64;

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function cancelled(signal: AbortSignal | undefined, reasons: Set<string>): boolean {
  if (signal?.aborted !== true) return false;
  reasons.add(INVENTORY_CANCELLED_REASON);
  return true;
}

export function normalizeConfigIdentity(value: string, reasons: Set<string>): string {
  if (value.length > 0 && value.length <= 256 && !CONTROL_CHARACTER.test(value)) return value;
  reasons.add('config-identity-invalid');
  return 'config:unavailable';
}
