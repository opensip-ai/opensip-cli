/**
 * @fileoverview Re-export shim — implementation lives in @opensip-cli/core.
 *
 * Keeps `_resetPublicApiGraphCache` on this path for existing tests.
 */

export { _resetPublicApiGraphCache, isInPublicApiSurface } from '@opensip-cli/core';
