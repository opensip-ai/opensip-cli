/**
 * @fileoverview violation → core `Signal` mapping (ADR-0011, Phase 6).
 *
 * Fitness is NOT signal-native: a check produces `RecipeViolation`s
 * (`{ file, line, column?, message, severity, suggestion? }`) which the
 * legacy `buildCliOutput` flattened straight into the retired
 * `CheckOutput`/`FindingOutput` husk. This module is the new seam — it maps
 * each violation to a core {@link Signal} (the universal output currency), so
 * the run can be assembled into the one {@link SignalEnvelope} the composition
 * root renders, emits, and delivers.
 *
 * `source === ruleId === checkSlug`: a fitness unit's slug IS its check slug,
 * and the terminal table groups signals by `signal.source` into one row per
 * check, so both fields carry the slug (parity with the prior
 * `FindingOutput.ruleId = cr.checkSlug`).
 *
 * Severity: `RecipeViolation.severity` is the 2-level legacy `error|warning`.
 * Per ADR-0011 we PRESERVE the 4-level `SignalSeverity` on the wire, mapping
 * the legacy levels UP (never collapsing): `error → high`, `warning → medium`.
 * That keeps the envelope's error/warning bucketing (`critical|high → error`,
 * `medium|low → warning`) numerically identical to the old check counts, so
 * the gate, verdict, and dashboard all agree.
 */

import { createSignalFromViolation } from '@opensip-cli/core';

import type { RecipeCheckResult } from '../recipes/types.js';
import type { Signal } from '@opensip-cli/core';

/** A single fitness violation, as carried on {@link RecipeCheckResult.violations}. */
type RecipeViolation = NonNullable<RecipeCheckResult['violations']>[number];

/**
 * Map a single check violation to a core {@link Signal}.
 *
 * Release 2.13.0 (§5.9): delegates to the shared `createSignalFromViolation`, which
 * STAMPS identity — `source`/`ruleId` both carry `checkSlug` (the fitness unit
 * slug) and the wire `severity` is lifted by `SeverityPolicy` (`error → high`,
 * `warning → medium`). Byte-identical to the former hand-mapping.
 */
export function violationToSignal(checkSlug: string, violation: RecipeViolation): Signal {
  return createSignalFromViolation(checkSlug, checkSlug, {
    message: violation.message,
    severity: violation.severity,
    suggestion: violation.suggestion,
    file: violation.file,
    line: violation.line,
    column: violation.column,
    fixAction: violation.fixAction,
    fixConfidence: violation.fixConfidence,
    repair: violation.repair,
  });
}
