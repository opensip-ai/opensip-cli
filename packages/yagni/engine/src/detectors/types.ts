import type { YagniConfig } from '../types/yagni-config.js';
import type { Signal } from '@opensip-cli/core';

export interface YagniDetectorContext {
  readonly cwd: string;
  readonly config: YagniConfig;
  readonly includeTests: boolean;
  readonly pathRoots?: readonly string[];
}

export interface YagniDetectorResult {
  readonly signals: readonly Signal[];
  readonly durationMs: number;
}

export interface YagniDetector {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  run(ctx: YagniDetectorContext): Promise<YagniDetectorResult>;
}

export interface SkippedDetector {
  readonly id: string;
  readonly slug: string;
  readonly reason: 'disabled';
  readonly detail?: string;
}
