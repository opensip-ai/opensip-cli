/**
 * Failure funnel for platform-support registry validation.
 *
 * Leaf module so the pure-data `platform-support-rows` importer and the
 * eval/select path share one code without cycles through policy modules.
 */

import { coreErrorCatalog } from './errors/core-error-catalog.js';
import { SystemError } from './errors.js';

const INVALID = coreErrorCatalog.require('CORE.PLATFORM_SUPPORT.INVALID');

/** Closed platform-support validation branches. */
export type PlatformSupportCondition =
  | 'empty-registry'
  | 'duplicate-id'
  | 'overlapping-tuple'
  | 'unknown-status'
  | 'preview-profile-missing'
  | 'preview-evidence-missing'
  | 'preview-evidence-policy'
  | 'invalid-tuple'
  | 'invalid-node-abi'
  | 'install-channel-empty'
  | 'install-channel-duplicate'
  | 'invalid-profile'
  | 'invalid-docs-path'
  | 'invalid-docs-url'
  | 'invalid-evidence-metadata'
  | 'invalid-evidence-artifact'
  | 'evidence-url-missing'
  | 'missing-field'
  | 'bounded-text'
  | 'bounded-token'
  | 'positive-integer'
  | 'major-mismatch'
  | 'supported-profile-missing'
  | 'supported-evidence-missing'
  | 'supported-qualification-missing'
  | 'supported-install-channels'
  | 'supported-public-docs'
  | 'supported-evidence-policy'
  | 'select-best-empty';

/** Raise a definition-backed platform-support registry failure. */
export function platformSupportError(
  condition: PlatformSupportCondition,
  message: string,
  rowId?: string,
): SystemError {
  return new SystemError(message, {
    code: INVALID.code,
    definition: INVALID,
    metadata: {
      condition,
      ...(rowId === undefined ? {} : { rowId }),
    },
  });
}
