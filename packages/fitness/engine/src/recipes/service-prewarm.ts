/**
 * @fileoverview Prewarm pattern computation for fitness recipe execution
 *
 * Derives glob patterns from resolved checks' fileTypes for file-cache prewarming.
 */

import { DEFAULT_PREWARM_PATTERNS } from '../framework/file-cache.js';

import type { Check } from '../framework/registry.js';

/**
 * Compute prewarm glob patterns from the resolved checks' fileTypes.
 *
 * When any check is universal (no fileTypes), the result is the UNION of
 * DEFAULT_PREWARM_PATTERNS and every declared fileType — the old
 * early-return dropped the declared extensions, so a run containing one
 * universal check silently never prewarmed e.g. `.map`/`.py` files and the
 * checks that declared them saw a scheduling-dependent universe.
 */
export function computePrewarmPatterns(checks: readonly Check[]): readonly string[] {
  const extensions = new Set<string>();
  let hasUniversal = false;
  for (const check of checks) {
    const ft = check.config.fileTypes;
    if (!ft || ft.length === 0) {
      hasUniversal = true;
      continue;
    }
    for (const ext of ft) {
      extensions.add(ext);
    }
  }
  const declared = [...extensions].sort().map((ext) => `**/*.${ext}`);
  if (!hasUniversal) return declared;
  const union = new Set<string>([...DEFAULT_PREWARM_PATTERNS, ...declared]);
  return [...union];
}
