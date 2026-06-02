/**
 * `applySeverityOverride` — the opt-in, baseline-neutral severity clamp
 * (ADR-0005, resolved 2026-06-02).
 *
 * A rule's per-signal severity (including Phase D's multi-band ladders) is the
 * **base**. `GraphConfig.severityOverrides[slug]` clamps it **only when
 * explicitly set** (`'error' → 'high'`, `'warning' → 'medium'`);
 * `defaultSeverity` stays metadata, never the emitted value. With NO override
 * configured the base is returned unchanged — so every existing rule's emitted
 * severity is byte-for-byte identical to before this wiring (no baseline /
 * Code-Scanning churn). A naive `defaultSeverity → severity` mapping was
 * rejected: it would push the four `low` rules to `medium` and churn the
 * baseline.
 *
 * Lives under `rules/` (peer to the prefixed helpers `_approximation.ts`,
 * `_entry-points.ts`) — no new layer crossing.
 */

import type { GraphConfig } from '../types.js';
import type { SignalSeverity } from '@opensip-tools/core';

/**
 * Clamp a rule's base severity per the opt-in override channel.
 *
 * @param base   The severity the rule's predicate chose for this signal.
 * @param slug   The rule's `graph:<slug>` id (the override key).
 * @param config The active {@link GraphConfig}.
 * @returns The override target when an override is set for `slug`, else `base`.
 */
export function applySeverityOverride(
  base: SignalSeverity,
  slug: string,
  config: GraphConfig,
): SignalSeverity {
  const override = config.severityOverrides?.[slug];
  if (override === undefined) return base;
  return override === 'error' ? 'high' : 'medium';
}
