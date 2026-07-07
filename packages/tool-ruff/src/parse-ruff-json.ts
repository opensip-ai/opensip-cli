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

function diagnostics(raw: ParsedScannerOutput): readonly unknown[] {
  if (raw.json !== undefined) return asArray(raw.json) ?? [];
  const parsed = safeParseJson(raw.raw);
  return parsed.ok ? (asArray(parsed.value) ?? []) : [];
}

function normalize(entry: unknown): Signal | undefined {
  const issue = asObject(entry);
  if (issue === undefined) return undefined;
  const ruleId = getString(issue, 'code') ?? 'ruff';
  const location = asObject(issue.location);
  const severity = nativeLabelToSeverity(getString(issue, 'severity'), 'medium');
  return createSignal({
    source: 'ruff',
    category: 'quality',
    severity,
    ruleId,
    message: getString(issue, 'message') ?? ruleId,
    code: {
      file: getString(issue, 'filename') ?? '',
      ...(getNumber(location, 'row') === undefined ? {} : { line: getNumber(location, 'row') }),
      ...(getNumber(location, 'column') === undefined
        ? {}
        : { column: getNumber(location, 'column') }),
    },
    metadata: withNativeSeverity(
      {
        url: getString(issue, 'url') ?? null,
        fixAvailable: asObject(issue.fix) !== undefined,
      },
      getString(issue, 'severity') ?? null,
    ),
  });
}

export function parseRuffJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const entry of diagnostics(raw)) {
    const signal = normalize(entry);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
