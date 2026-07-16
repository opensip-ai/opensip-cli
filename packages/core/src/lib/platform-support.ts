/**
 * Versioned platform-support policy registry (Plan 02 — macOS GA qualification).
 *
 * `engines.node` is an installation/runtime floor; it cannot encode OS, kernel,
 * architecture, Node ABI, npm major, filesystem, case behavior, or install
 * channel — nor the evidence status that separates a measured `supported` tuple
 * from an unmeasured `unqualified` one. This module is the feature facade: it
 * owns the contract version and re-exports its three collaborators as one stable
 * barrel — the type vocabulary (`./platform-support-types.js`), the frozen
 * registry data (`./platform-support-rows.js`), and the pure host classifier
 * (`./platform-support-eval.js`). The public barrel (`index-lib.ts`) imports the
 * whole surface from here, so the split is invisible to consumers.
 *
 * Design invariants:
 *   - Pure kernel policy: NO filesystem, process, or global reads; no
 *     module-level mutable state. `PLATFORM_SUPPORT_ROWS` is frozen data and the
 *     evaluators are pure functions of their explicit inputs.
 *   - `supported` means burn-in is complete and every release is gated by
 *     verified evidence. It is NEVER implied by package engine compatibility and
 *     is absent until an external gate promotes it. macOS launches as `preview`.
 *   - Classification never claims an unlisted host "cannot run": non-macOS,
 *     other Macs, and toolchain/filesystem drift all resolve to `unqualified`
 *     (may work, no promise). Only the complete published Intel/x64 tuple is
 *     `unsupported`.
 *   - `match: 'exact'` requires EVERY normative dimension observed and matching.
 *     A single missing dimension downgrades to `partial` (the row's status may
 *     still be advertised, but never as an exact match).
 *   - Collaborators depend on the type leaf one-directionally (types are erased
 *     at runtime), so there is no import cycle back into this facade.
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

/**
 * The platform-support contract version. Bumped only on a breaking change to the
 * support-row shape or classification semantics, gated by evidence/profile/docs
 * review (see the `platform-support` compatibility policy). Acceptance profiles
 * bind this version so evidence can never match a different public claim.
 */
export const PLATFORM_SUPPORT_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Collaborators (re-exported for a stable barrel)
// ---------------------------------------------------------------------------

// Type vocabulary (dependency-free leaf).
export type {
  PlatformSupportStatus,
  PlatformSupportTuple,
  PlatformSupportProfileRef,
  PlatformSupportEvidence,
  PlatformQualification,
  PlatformSupportRow,
  ObservedHost,
  PlatformDimension,
  PlatformMismatchReason,
  PlatformMatchLevel,
  HostSupportAssessment,
  RuntimeHostFacts,
  RuntimeHostSupportProjection,
} from './platform-support-types.js';

// Frozen registry data (validated fail-closed at its own module load).
export { PLATFORM_SUPPORT_ROWS } from './platform-support-rows.js';

// Pure host classifier.
export { assessHostSupport, projectRuntimeHostSupport } from './platform-support-eval.js';
