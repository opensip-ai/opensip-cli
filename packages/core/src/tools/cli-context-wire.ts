/**
 * Layer-safe wire aliases shared by the host-provided tool context.
 *
 * Core cannot import the contracts package, so the composition root narrows
 * these structural values at the core-to-host boundary.
 */

/**
 * Wire alias for run envelopes passed across the core ↔ CLI seam.
 *
 * Shape-sync tests protect the concrete contracts type while core retains its
 * lower-layer dependency posture.
 */
/* eslint-disable sonarjs/redundant-type-aliases -- intentional named alias for the unknown cross-layer wire seam */
export type WireSignalEnvelope = unknown;

/**
 * Structural mirror of contracts' non-fatal `WarningDetail` run notice.
 */
export interface WireWarningDetail {
  readonly message: string;
  readonly code?: string;
}
