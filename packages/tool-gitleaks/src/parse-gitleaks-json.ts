/**
 * @fileoverview Gitleaks JSON → normalized `Signal[]` (ADR-0090 §4, brief §4).
 *
 * Gitleaks emits a BARE JSON ARRAY of findings (`[]` when clean). Each finding
 * carries the live credential in two fields — `Secret` (the raw secret) and
 * `Match` (the surrounding region, which INCLUDES the secret). Neither may EVER
 * reach `Signal.message`, `Signal.metadata` in raw form, or any egress payload:
 * this parser stores ONLY a {@link redactSecret} preview of `Secret` and drops
 * `Match` entirely. The secret-egress negative test proves no raw substring
 * survives.
 *
 * Stock gitleaks emits NO severity (every secret is treated as `high`); the
 * native-severity slot records `null` so a downstream reader knows the four-bucket
 * `high` is the adapter's constant map, not a scanner label.
 *
 * Pure: defensive JSON navigation (never throws on malformed input → `[]`).
 */

import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  redactSecret,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

/** Read the parsed finding array from the descriptor payload, defensively. */
function findingArray(raw: ParsedScannerOutput): readonly unknown[] {
  // The run loop pre-parses JSON for `kind: 'json'`; fall back to the raw bytes
  // (the acceptance-harness path) so the parser is total either way.
  const json = raw.json ?? safeParse(raw.raw);
  return asArray(json) ?? [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Normalize one gitleaks finding to a {@link Signal}. Returns `undefined` for a
 * non-object entry so a malformed element is skipped rather than throwing.
 */
function normalizeFinding(entry: unknown): Signal | undefined {
  const finding = asObject(entry);
  if (finding === undefined) return undefined;

  const ruleId = getString(finding, 'RuleID') ?? 'gitleaks-secret';
  const message = getString(finding, 'Description') ?? `Secret detected (${ruleId})`;
  const file = getString(finding, 'File') ?? '';
  const line = getNumber(finding, 'StartLine');
  const column = getNumber(finding, 'StartColumn');

  // SECRET HYGIENE: `Secret` is masked to a short non-reversible preview; `Match`
  // (which embeds the secret) is NEVER read into the bag. The metadata carries no
  // raw credential bytes.
  const secretPreview = redactSecret(getString(finding, 'Secret'));

  const metadata = withNativeSeverity(
    {
      nativeFingerprint: getString(finding, 'Fingerprint') ?? null,
      entropy: getNumber(finding, 'Entropy') ?? null,
      tags: asArray(finding.Tags) ?? [],
      ...(secretPreview.length > 0 ? { secretPreview } : {}),
    },
    // Stock gitleaks emits no severity — record `null` beside the constant `high`.
    null,
  );

  return createSignal({
    source: 'gitleaks',
    category: 'security',
    severity: 'high',
    ruleId,
    message,
    code: {
      file,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    },
    metadata,
  });
}

/**
 * Parse gitleaks JSON output into normalized signals. A clean run (`[]`) yields
 * no findings; every secret maps to a `high`-severity `security` signal with a
 * REDACTED secret preview and no raw credential anywhere.
 */
export function parseGitleaksJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const entry of findingArray(raw)) {
    const signal = normalizeFinding(entry);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
