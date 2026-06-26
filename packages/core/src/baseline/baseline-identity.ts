/**
 * @fileoverview Baseline identity compatibility helpers (ADR-0075).
 *
 * Pure comparison/formatting for fingerprint strategy metadata persisted in
 * generic baseline meta. The host never re-fingerprints — it only compares
 * stored `{ id, version }` against the current envelope's baseline identity.
 */

/** Baseline identity carried on a built {@link SignalEnvelope}. */
export interface BaselineIdentity {
  readonly fingerprintStrategyId: string;
  readonly fingerprintStrategyVersion: number;
}

/** Persisted baseline identity metadata in `tool_baseline_meta`. */
export interface BaselineIdentityMetadata {
  readonly baselineFormatVersion: number;
  readonly fingerprintStrategyId: string;
  readonly fingerprintStrategyVersion: number;
}

/** Current baseline format version written on save. */
export const BASELINE_FORMAT_VERSION = 1;

/** True when stored metadata matches the current envelope identity. */
export function isBaselineIdentityCompatible(
  current: BaselineIdentity,
  stored: BaselineIdentityMetadata | null | undefined,
): boolean {
  if (!stored) return false;
  if (stored.baselineFormatVersion !== BASELINE_FORMAT_VERSION) return false;
  if (!stored.fingerprintStrategyId || stored.fingerprintStrategyVersion < 1) return false;
  return (
    stored.fingerprintStrategyId === current.fingerprintStrategyId &&
    stored.fingerprintStrategyVersion === current.fingerprintStrategyVersion
  );
}

/** Human-readable mismatch detail for ConfigurationError messages. */
export function formatBaselineIdentityMismatch(
  tool: string,
  current: BaselineIdentity,
  stored: BaselineIdentityMetadata | null | undefined,
): string {
  const storedId = stored?.fingerprintStrategyId ?? '(missing)';
  const storedVersion =
    stored?.fingerprintStrategyVersion === undefined
      ? '(missing)'
      : String(stored.fingerprintStrategyVersion);
  return (
    `Baseline identity for '${tool}' is incompatible with the current tool fingerprint strategy. ` +
    `Stored: id=${storedId}, version=${storedVersion}. ` +
    `Current: id=${current.fingerprintStrategyId}, version=${current.fingerprintStrategyVersion}. ` +
    `Recapture with \`opensip ${tool} --gate-save\`.`
  );
}

/** Project envelope identity into persisted metadata. */
export function toBaselineIdentityMetadata(identity: BaselineIdentity): BaselineIdentityMetadata {
  return {
    baselineFormatVersion: BASELINE_FORMAT_VERSION,
    fingerprintStrategyId: identity.fingerprintStrategyId,
    fingerprintStrategyVersion: identity.fingerprintStrategyVersion,
  };
}
