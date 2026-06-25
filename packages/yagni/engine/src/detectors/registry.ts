import { duplicateBodyCandidateDetector } from './duplicate-body-candidate.js';
import { unusedConfigSurfaceDetector } from './unused-config-surface.js';

import type { YagniDetector } from './types.js';

/**
 * Built-in detector registry in stable registration order.
 *
 * Duplicate-body detection is back (ADR-0064) but now owns NO detection math: it builds
 * yagni's own TypeScript inventory and calls `findDuplicateBodies` from the shared
 * `@opensip-cli/clone-detection` substrate — the same implementation + policy graph uses,
 * so the 430-vs-0 divergence cannot recur (cross-tool parity test guards it). yagni keeps
 * NO dependency on `@opensip-cli/graph`.
 */
export const YAGNI_DETECTORS: readonly YagniDetector[] = [
  unusedConfigSurfaceDetector,
  duplicateBodyCandidateDetector,
];
