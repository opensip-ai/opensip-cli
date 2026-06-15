/**
 * Extract the inner `__version` (if present and valid) from an opaque tool-owned payload.
 *
 * This is the single canonical helper for the payload schema evolution convention.
 * It is intentionally pure, tiny, and has zero knowledge of any tool's payload shape
 * (FitnessSessionPayload, GraphSessionPayload, etc.). Callers in session-store and
 * the individual tools use it to decide legacy projection vs. current shape.
 *
 * Rules (defensive, per plan hardening):
 * - Only plain objects are inspected.
 * - `__version` must be a positive finite number.
 * - Missing, non-numeric, <=0, Infinity, NaN → undefined (treated as legacy v1 by callers).
 */
export function extractPayloadVersion(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const v = (payload as Record<string, unknown>).__version;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v;
  }
  return undefined;
}
