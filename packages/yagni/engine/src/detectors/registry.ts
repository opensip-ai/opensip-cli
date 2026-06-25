import { unusedConfigSurfaceDetector } from './unused-config-surface.js';

import type { YagniDetector } from './types.js';

/**
 * Built-in detector registry in stable registration order.
 *
 * Duplicate-body detection was removed in v0.1.12 (ADR-0063): it re-implemented
 * `graph:duplicated-function-body` and diverged from it. Duplicate / near-duplicate
 * analysis now lives in `opensip graph`. yagni's audit is config-surface reduction
 * until the Track 2 reduction coordinator re-ingests graph's curated findings.
 */
export const YAGNI_DETECTORS: readonly YagniDetector[] = [unusedConfigSurfaceDetector];
