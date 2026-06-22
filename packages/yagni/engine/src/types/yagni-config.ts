/**
 * Resolved YAGNI tool configuration — mirrors the `yagni:` namespace block.
 */

import type { YagniConfidence } from './yagni-metadata.js';

export type YagniGraphMode = 'auto' | 'reuse' | 'build' | 'off';

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
