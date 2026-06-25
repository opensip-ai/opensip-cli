/**
 * @fileoverview Near-duplicate MinHash/LSH primitives — relocated to
 * `@opensip-cli/clone-detection`.
 *
 * The signature constants + digest tail moved to the shared layer-2 substrate
 * (ADR-0064) so graph and yagni single-source them. This module re-exports the same
 * symbols verbatim so existing importers of `'../lang-adapter/near-duplicate-signature.js'`
 * are unchanged and signature VALUES (and the `sig=` cache-key segment) stay
 * byte-identical. `NEAR_DUP_SIGNATURE_VERSION` is unchanged by the move.
 */

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
} from '@opensip-cli/clone-detection';
