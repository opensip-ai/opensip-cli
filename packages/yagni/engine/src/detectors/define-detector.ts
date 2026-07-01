import { namespacedRuleId } from '@opensip-cli/core';

import type { YagniDetector } from './types.js';

const DETECTOR_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * Validating detector factory for bundled and future YAGNI detectors.
 *
 * @throws {Error} When the detector id is not kebab-case, the slug is not the
 *   `yagni:`-namespaced form of the id, or the description is empty.
 */
export function defineDetector(detector: YagniDetector): YagniDetector {
  if (!DETECTOR_ID_RE.test(detector.id)) {
    throw new Error(`Invalid YAGNI detector id '${detector.id}': expected kebab-case`);
  }
  const expectedSlug = namespacedRuleId('yagni', detector.id);
  if (detector.slug !== expectedSlug) {
    throw new Error(`Invalid YAGNI detector slug '${detector.slug}': expected '${expectedSlug}'`);
  }
  if (detector.description.trim() === '') {
    throw new Error(`YAGNI detector '${detector.id}' must provide a description`);
  }
  return Object.freeze(detector);
}
