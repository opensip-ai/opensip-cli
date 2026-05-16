/**
 * Rule registry (skeleton; populated in P4 + P5).
 *
 * A plain `readonly Rule[]` — not a Registry singleton. v0.2 ships
 * with five built-in rules. Per PR-6, runtime rule loading is deferred
 * to v0.3.
 */

import type { Rule } from '../types.js';

export const rules: readonly Rule[] = [];
