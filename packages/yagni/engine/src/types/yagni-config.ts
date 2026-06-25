/**
 * Resolved YAGNI tool configuration — mirrors the `yagni:` namespace block.
 */

import type { YagniConfidence } from './yagni-metadata.js';

/**
 * Graph evidence mode. DEPRECATED & INERT since v0.1.12 (ADR-0063): yagni no
 * longer builds or reuses a graph. The values are still accepted (so existing
 * config/env keep validating) and carried onto the session for continuity, but
 * have no effect; the command warns when `--graph` is passed. Targeted for
 * removal in 0.1.13. Duplicate/near-duplicate analysis lives in `opensip graph`.
 *
 * Note: not tagged `@deprecated` because the type is still a live carrier of the
 * accepted (inert) value across the config/session contract — it is the *mode*
 * that is deprecated, not the type symbol.
 */
export type YagniGraphMode = 'auto' | 'reuse' | 'build' | 'off';

/** Validated values from the `yagni:` config namespace. */
export interface YagniConfig {
  readonly failOnErrors?: number;
  readonly failOnWarnings?: number;
  readonly defaultMinConfidence?: YagniConfidence;
  readonly graphMode?: YagniGraphMode;
  readonly includeTests?: boolean;
  readonly disabledDetectors?: readonly string[];
  readonly detectorSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const DEFAULT_YAGNI_CONFIG: Required<
  Pick<
    YagniConfig,
    'failOnErrors' | 'failOnWarnings' | 'defaultMinConfidence' | 'graphMode' | 'includeTests'
  >
> = {
  failOnErrors: 0,
  failOnWarnings: 0,
  defaultMinConfidence: 'medium',
  graphMode: 'auto',
  includeTests: false,
};
