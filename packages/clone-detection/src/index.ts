/**
 * @opensip-cli/clone-detection — shared function-body clone-detection substrate.
 *
 * A pure, `node:crypto`-only leaf package (layer 2) that single-sources the body-hash
 * + MinHash primitives, the tool-neutral `CloneCandidate` shape, and the duplicate /
 * near-duplicate detection algorithms + curation policy. Both the graph tool and the
 * yagni tool depend on it (neither on the other), so there is exactly one
 * implementation and they cannot diverge (ADR-0064).
 */

// Body-hash primitives (relocated verbatim from graph — bodyHash is the catalog/cache
// /equivalence-guardrail identity; the values must never change).
export { normalizeWhitespace, hashBody, type BodyDigest } from './body-digest.js';

// MinHash / LSH near-duplicate primitives + algorithm constants.
export {
  NEAR_DUP_SIGNATURE_K,
  NEAR_DUP_LSH_BANDS,
  NEAR_DUP_LSH_ROWS,
  NEAR_DUP_SIGNATURE_VERSION,
  shingle,
  bodySignature,
  estimateJaccard,
  lshBandHashes,
  digestCanonicalBody,
  type BodyDigestWithSignature,
} from './near-duplicate-signature.js';

// Tool-neutral candidate + finding types, and the detection algorithms + curation
// policy (single-sourced — graph rules + yagni detector both consume these).
export type {
  FunctionKind,
  CloneCandidate,
  DupOpts,
  NearDupOpts,
  DuplicateGroup,
  CrossPackageAggregate,
  DuplicateFindings,
  NearDuplicateCluster,
} from './types.js';
export { findDuplicateBodies, isEligibleKind } from './find-duplicate-bodies.js';
export { findNearDuplicates } from './find-near-duplicates.js';
