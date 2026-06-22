/**
 * Resolved YAGNI tool configuration — mirrors the `yagni:` namespace block.
 */

export type YagniGraphMode = 'auto' | 'reuse' | 'build' | 'off';

export interface YagniConfig {
  readonly failOnErrors?: number;
  readonly failOnWarnings?: number;
  readonly defaultMinConfidence?: number;
  readonly graphMode?: YagniGraphMode;
  readonly includeTests?: boolean;
  readonly disabledDetectors?: readonly string[];
  readonly detectorSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const DEFAULT_YAGNI_CONFIG: Required<
  Pick<YagniConfig, 'failOnErrors' | 'failOnWarnings' | 'defaultMinConfidence' | 'graphMode' | 'includeTests'>
> = {
  failOnErrors: 0,
  failOnWarnings: 0,
  defaultMinConfidence: 0.5,
  graphMode: 'auto',
  includeTests: false,
};