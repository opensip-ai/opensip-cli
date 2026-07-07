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

function results(raw: ParsedScannerOutput): readonly unknown[] {
  const doc =
    raw.json === undefined
      ? (() => {
          const parsed = safeParseJson(raw.raw);
          return parsed.ok ? parsed.value : undefined;
        })()
      : raw.json;
  return asArray(asObject(doc)?.results) ?? [];
}

function normalize(entry: unknown): Signal | undefined {
  const result = asObject(entry);
  if (result === undefined) return undefined;
  const ruleId = getString(result, 'test_id') ?? getString(result, 'test_name') ?? 'bandit';
  const severityLabel = getString(result, 'issue_severity');
  const cwe = asObject(result.issue_cwe);
  const cweId = getNumber(cwe, 'id');
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
      ...(getNumber(result, 'col_offset') === undefined
        ? {}
        : { column: getNumber(result, 'col_offset') }),
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

export function parseBanditJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const entry of results(raw)) {
    const signal = normalize(entry);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
