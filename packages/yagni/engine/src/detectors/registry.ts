import { duplicateBodyCandidateDetector } from './duplicate-body-candidate.js';
import { unusedConfigSurfaceDetector } from './unused-config-surface.js';

import type { YagniDetector } from './types.js';

/** Built-in detector registry in stable registration order. */
export const YAGNI_DETECTORS: readonly YagniDetector[] = [
  unusedConfigSurfaceDetector,
  duplicateBodyCandidateDetector,
];
