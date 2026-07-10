/**
 * host-plane-state — reserved tool_state identity for host governance/audit/
 * entitlement blobs (ADR-0146).
 *
 * Host planes store opaque JSON under the reserved identity
 * `@opensip-cli/host-plane:<toolId>` so tool-owned `governance` / `audit` /
 * `entitlements` keys cannot collide with host compatibility data.
 *
 * One pure predicate recognizes the reserved prefix. Runtime Tool admission
 * (`validate-tool`) and binder-owned-key validation (`tool-owned-keys`) both
 * consume it; helpers and purge re-check as defense in depth.
 */

/** Exact reserved prefix for host-plane storage identities. */
export const HOST_PLANE_STATE_PREFIX = '@opensip-cli/host-plane:' as const;

/**
 * True when `value` begins with the reserved host-plane identity prefix.
 * Empty / non-string values are not reserved.
 */
export function isReservedHostPlaneIdentity(value: string): boolean {
  return value.startsWith(HOST_PLANE_STATE_PREFIX);
}

/**
 * Map a bound tool id to its reserved host-plane storage identity.
 *
 * @throws when `toolId` is empty/whitespace or already carries the reserved prefix
 */
export function hostPlaneStateIdentity(toolId: string): string {
  const trimmed = toolId.trim();
  if (trimmed.length === 0) {
    throw new Error('hostPlaneStateIdentity: toolId must be non-empty');
  }
  if (isReservedHostPlaneIdentity(trimmed)) {
    throw new Error(
      `hostPlaneStateIdentity: toolId already carries the reserved prefix (${HOST_PLANE_STATE_PREFIX})`,
    );
  }
  return `${HOST_PLANE_STATE_PREFIX}${trimmed}`;
}
