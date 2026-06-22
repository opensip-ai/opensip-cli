import type { GraphCatalog } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

import type { YagniConfig } from '../types/yagni-config.js';

export interface YagniDetectorContext {
  readonly cwd: string;
  readonly config: YagniConfig;
  readonly graphCatalog: GraphCatalog | null;
  readonly includeTests: boolean;
}

export interface YagniDetectorResult {
  readonly signals: readonly Signal[];
  readonly durationMs: number;
}

export interface YagniDetector {
  readonly id: string;
  readonly slug: string;
  readonly description: string;
  readonly requiresGraph: boolean;
  run(ctx: YagniDetectorContext): Promise<YagniDetectorResult>;
}

export interface SkippedDetector {
  readonly id: string;
  readonly slug: string;
  readonly reason: 'disabled' | 'graph-required' | 'graph-unavailable';
  readonly detail?: string;
}