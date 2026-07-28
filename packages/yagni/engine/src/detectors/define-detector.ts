import { createToolError, namespacedRuleId } from '@opensip-cli/core';

import { yagniErrorCatalog } from '../errors/yagni-error-catalog.js';

import type { YagniDetector } from './types.js';

const DETECTOR_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const INVALID_DEFINITION = yagniErrorCatalog.require('YAGNI.DETECTOR.INVALID_DEFINITION');

/**
 * Validating detector factory for bundled and future YAGNI detectors.
 *
 * @throws {Error} When the detector id is not kebab-case, the slug is not the
 *   `yagni:`-namespaced form of the id, or the description is empty.
 */
export function defineDetector(detector: YagniDetector): YagniDetector {
  if (!DETECTOR_ID_RE.test(detector.id)) {
    throw createToolError(
      INVALID_DEFINITION,
      `Invalid YAGNI detector id '${detector.id}': expected kebab-case`,
      { metadata: { condition: 'id', detectorId: detector.id } },
    );
  }
  const expectedSlug = namespacedRuleId('yagni', detector.id);
  if (detector.slug !== expectedSlug) {
    throw createToolError(
      INVALID_DEFINITION,
      `Invalid YAGNI detector slug '${detector.slug}': expected '${expectedSlug}'`,
      { metadata: { condition: 'slug', detectorId: detector.id } },
    );
  }
  if (detector.description.trim() === '') {
    throw createToolError(
      INVALID_DEFINITION,
      `YAGNI detector '${detector.id}' must provide a description`,
      { metadata: { condition: 'description', detectorId: detector.id } },
    );
  }
  return Object.freeze(detector);
}
