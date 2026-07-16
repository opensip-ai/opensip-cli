import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  nativeLabelToSeverity,
  safeParseJson,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

function document(raw: ParsedScannerOutput): Record<string, unknown> | undefined {
  const doc =
    raw.json === undefined
      ? (() => {
          const parsed = safeParseJson(raw.raw);
          return parsed.ok ? parsed.value : undefined;
        })()
      : raw.json;
  return asObject(doc);
}

/** Bandit reports 0-based `col_offset`; OpenSIP columns are 1-based. */
function columnFromOffset(colOffset: number | undefined): number | undefined {
  if (colOffset === undefined || colOffset < 0) return undefined;
  return colOffset + 1;
}

function normalizeResult(entry: unknown): Signal | undefined {
  const result = asObject(entry);
  if (result === undefined) return undefined;
  const ruleId = getString(result, 'test_id') ?? getString(result, 'test_name') ?? 'bandit';
  const severityLabel = getString(result, 'issue_severity');
  const cwe = asObject(result.issue_cwe);
  const cweId = getNumber(cwe, 'id');
  const column = columnFromOffset(getNumber(result, 'col_offset'));
  return createSignal({
    source: 'bandit',
    category: 'security',
    severity: nativeLabelToSeverity(severityLabel, 'medium'),
    ruleId,
    message: getString(result, 'issue_text') ?? ruleId,
    code: {
      file: getString(result, 'filename') ?? '',
      ...(getNumber(result, 'line_number') === undefined
        ? {}
        : { line: getNumber(result, 'line_number') }),
      ...(column === undefined ? {} : { column }),
    },
    metadata: withNativeSeverity(
      {
        testName: getString(result, 'test_name') ?? null,
        confidence: getString(result, 'issue_confidence') ?? null,
        cwe: cweId === undefined ? null : `CWE-${String(cweId)}`,
        cweLink: getString(cwe, 'link') ?? null,
      },
      severityLabel ?? null,
    ),
  });
}

/**
 * Surface Bandit `errors[]` (syntax/skip reasons) as quality findings so operators
 * still see unreadable files instead of a silent empty scan.
 */
function normalizeError(entry: unknown): Signal | undefined {
  const error = asObject(entry);
  if (error === undefined) return undefined;
  const filename = getString(error, 'filename') ?? '';
  const reason = getString(error, 'reason') ?? 'Bandit could not analyze this file';
  return createSignal({
    source: 'bandit',
    category: 'quality',
    severity: 'medium',
    ruleId: 'bandit-error',
    message: reason,
    code: { file: filename },
    metadata: withNativeSeverity({ reason }, null),
  });
}

/**
 * Parse Bandit's JSON report into normalized signals — one per entry in the
 * top-level `results[]` array, plus any `errors[]` (skipped/unreadable files).
 * Each result maps to a security signal keyed by `test_id`/`test_name`, carrying
 * its severity, location, confidence, and CWE. Columns are 1-based
 * (`col_offset + 1`).
 */
export function parseBanditJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const doc = document(raw);
  const signals: Signal[] = [];
  for (const entry of asArray(doc?.results) ?? []) {
    const signal = normalizeResult(entry);
    if (signal !== undefined) signals.push(signal);
  }
  for (const entry of asArray(doc?.errors) ?? []) {
    const signal = normalizeError(entry);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
