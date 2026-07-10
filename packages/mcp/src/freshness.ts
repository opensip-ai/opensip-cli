/**
 * Catalog freshness mapping for MCP graph responses (MCP Graph Audit Phase 1).
 *
 * Complete verification lives in `@opensip-cli/graph/read` (`verifyCatalogInputs`).
 * This module maps verification / missing states onto the agent-facing
 * {@link Freshness} DTO and supplies the degraded status used by `review_change`.
 */

import type { Freshness } from './symbol-dto.js';
import type { FreshnessVerification } from '@opensip-cli/graph/read';

/** Freshness for an absent catalog — empty data, explicit refresh required. */
export function missingFreshness(): Freshness {
  return {
    fresh: false,
    verifiedAt: new Date().toISOString(),
    verification: 'missing',
    reasonCode: 'missing',
    reason: 'No graph catalog is loaded',
  };
}

/** Map a complete verification result to the response freshness DTO. */
export function freshnessFromVerification(
  verification: FreshnessVerification,
  builtAt?: string,
): Freshness {
  // Partial verification can never claim unqualified fresh.
  const fresh = verification.verification === 'complete' && verification.fresh;
  return {
    fresh,
    ...(builtAt === undefined ? {} : { builtAt }),
    verifiedAt: verification.verifiedAt,
    verification: verification.verification,
    ...(verification.reasonCode === undefined ? {} : { reasonCode: verification.reasonCode }),
    ...(verification.reason === undefined ? {} : { reason: verification.reason }),
    ...(verification.changes === undefined ? {} : { changes: verification.changes }),
  };
}

/**
 * Bounded degraded status for `review_change` when graph status is unavailable.
 * Stored ReviewBrief replay must still succeed.
 */
export function unavailableGraphStatus(): Freshness {
  return {
    fresh: false,
    verifiedAt: new Date().toISOString(),
    verification: 'partial',
    reasonCode: 'verification-unavailable',
    reason: 'Graph status unavailable',
  };
}
