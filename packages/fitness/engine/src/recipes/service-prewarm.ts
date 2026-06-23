/**
 * @fileoverview Prewarm pattern computation for fitness recipe execution
 *
 * Derives glob patterns from resolved checks' fileTypes for file-cache prewarming.
 */

import { DEFAULT_PREWARM_PATTERNS } from '../framework/file-cache.js';

import type { Check } from '../framework/registry.js';

/**
 * Compute prewarm glob patterns from the resolved checks' fileTypes.
 * If any check is universal (no fileTypes), falls back to DEFAULT_PREWARM_PATTERNS.
 */
export function computePrewarmPatterns(checks: readonly Check[]): readonly string[] {
  const extensions = new Set<string>();
  for (const check of checks) {
    const ft = check.config.fileTypes;
    if (!ft || ft.length === 0) {
      // Universal check — need all file types
      return DEFAULT_PREWARM_PATTERNS;
    }
    for (const ext of ft) {
      extensions.add(ext);
    }
  }
  return [...extensions].sort().map((ext) => `**/*.${ext}`);
}