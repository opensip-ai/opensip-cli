/**
 * The one failure funnel for an internally inconsistent scaffold asset.
 *
 * Agent-guidance snapshots, their render targets, and authored-plan blobs are static tables
 * compiled into this build. When they disagree with each other the CLI knows exactly which asset
 * is at fault — and every one of these sites used to throw a bare `Error`, which normalizes to
 * `SYSTEM_ERROR` (exposure `redacted`), so a complete diagnosis reached the user as
 * "The operation failed."
 */

import { SystemError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

const SCAFFOLD_ASSET_INVALID = hostErrorCatalog.require('CLI.INIT.SCAFFOLD_ASSET_INVALID');

/**
 * The way a shipped scaffold asset failed its own consistency rules (D9).
 *
 * A closed union rather than a free string: these are the four structural rules the static
 * tables must satisfy, and a new one should be a deliberate addition, not a typo.
 */
export type ScaffoldAssetCondition =
  'snapshot-absent' | 'snapshot-duplicate' | 'target-unknown' | 'blob-unknown';

/** @throws {SystemError} always — a shipped scaffold asset is inconsistent. */
export function scaffoldAssetFailure(
  message: string,
  condition: ScaffoldAssetCondition,
  asset: string,
): never {
  throw new SystemError(message, {
    code: SCAFFOLD_ASSET_INVALID.code,
    definition: SCAFFOLD_ASSET_INVALID,
    metadata: { condition, asset },
    diagnostic: condition,
  });
}
