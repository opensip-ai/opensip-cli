/**
 * @fileoverview Severity mapping for external-scanner ingestion (ADR-0091).
 *
 * Pure functions only. Two jobs:
 *   1. CVSS number → OpenSIP four-bucket severity (FIRST/NVD v3 bands).
 *   2. SARIF `level` → severity FALLBACK (lossy — the OpenSIP SARIF writer
 *      collapses `critical` AND `high` to `error`, so a level-only inverse can
 *      never recover `critical`; `error → high`).
 *
 * Native severity is always preserved on `Signal.metadata` beside the mapped
 * four-bucket `Signal.severity` (the four-bucket set is `critical|high|medium|low`
 * — there is no info/unknown rung).
 */

import type { SignalSeverity } from '@opensip-cli/core';

/** SARIF v2.1.0 levels. */
export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

/**
 * Map a CVSS base score to the OpenSIP four-bucket severity using the FIRST/NVD
 * v3 bands: `>= 9.0` critical · `7.0–8.9` high · `4.0–6.9` medium ·
 * `0.1–3.9` low · `0`/non-finite → low.
 */
export function cvssToSeverity(score: number): SignalSeverity {
  if (!Number.isFinite(score) || score <= 0) return 'low';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/**
 * Parse a CVSS number out of a value that may be a number or a numeric string
 * (e.g. SARIF `security-severity` `"9.8"`, OSV `groups[].max_severity` `"7.5"`).
 * A CVSS *vector* string (`"CVSS:3.1/AV:N/…"`) has no leading number and returns
 * `undefined`. Returns `undefined` for anything non-numeric.
 */
export function parseCvss(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Reject CVSS vector strings (they start with "CVSS:" and carry no base score
  // we can read without computing it).
  if (/^cvss:/i.test(trimmed)) return undefined;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * SARIF `level` → severity FALLBACK (used only when a CVSS `security-severity`
 * is absent). `error → high` (NEVER critical), `warning → medium`,
 * `note → low`, `none → low`. An absent/unknown level defaults to the SARIF
 * default rung (`warning` → medium).
 */
export function sarifLevelToSeverity(level: string | undefined): SignalSeverity {
  switch (level) {
    case 'error': {
      return 'high';
    }
    case 'warning': {
      return 'medium';
    }
    case 'note': {
      return 'low';
    }
    case 'none': {
      return 'low';
    }
    default: {
      return 'medium';
    }
  }
}

/**
 * Merge the scanner's NATIVE severity label/number onto a metadata bag under
 * `nativeSeverity` (preserved beside the mapped four-bucket `Signal.severity`).
 * `null` records "the scanner emits no severity" (e.g. stock gitleaks).
 */
export function withNativeSeverity(
  metadata: Readonly<Record<string, unknown>>,
  nativeSeverity: unknown,
): Record<string, unknown> {
  return { ...metadata, nativeSeverity: nativeSeverity ?? null };
}
