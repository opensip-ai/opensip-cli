export const CONTROL_CHARACTER = /\p{Cc}/u;
export const INVENTORY_CANCELLED_REASON = 'inventory-cancelled';
/**
 * The run hit its wall-clock ceiling. Emitted ALONGSIDE (never instead of)
 * {@link INVENTORY_CANCELLED_REASON} so an expired deadline is never mistaken for an
 * operator interrupt, and neither is ever mistaken for a merely capped run (ruling D7).
 */
export const INVENTORY_DEADLINE_REASON = 'inventory-deadline-exceeded';
/**
 * The assembled snapshot failed its own contract schema. The verdict is withdrawn rather
 * than published, but the withdrawal itself is coded evidence instead of a thrown error.
 */
export const INVENTORY_SNAPSHOT_INVALID_REASON = 'inventory-snapshot-invalid';
/**
 * Coverage carried more distinct reason codes than the contract retains, so the tail was
 * dropped. Never dropped: {@link INVENTORY_CANCELLED_REASON} and
 * {@link INVENTORY_DEADLINE_REASON} (see `retainedCoverageReasons`).
 */
export const REASON_CAP_REACHED = 'reason-cap-reached';
/** A host targeting capability did not settle inside its per-invocation budget. */
export const BOUNDED_CAPABILITY_TIMEOUT_REASON = 'bounded-capability-timeout';
/** A manifest-walk visitor threw. The walk is qualified rather than rejected. */
export const MANIFEST_VISITOR_FAILED_REASON = 'manifest-visitor-failed';
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
