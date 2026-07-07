import { createSignal } from '@opensip-cli/core';
import {
  asArray,
  asObject,
  getNumber,
  getString,
  nativeLabelToSeverity,
  parseJsonLines,
  withNativeSeverity,
} from '@opensip-cli/external-tool-adapter';

import type { Signal } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

function diagnosticOf(value: unknown): Record<string, unknown> | undefined {
  const root = asObject(value);
  return asObject(root?.fields) ?? asObject(root?.message) ?? root;
}

function firstSpan(diagnostic: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(asArray(diagnostic.spans)?.[0]);
}

function ruleIdOf(diagnostic: Record<string, unknown>): string {
  const code = asObject(diagnostic.code);
  return getString(code, 'code') ?? getString(diagnostic, 'code') ?? 'cargo-deny';
}

function normalize(value: unknown): Signal | undefined {
  const diagnostic = diagnosticOf(value);
  if (diagnostic === undefined) return undefined;
  const message = getString(diagnostic, 'message');
  if (message === undefined) return undefined;
  const level = getString(diagnostic, 'level');
  const span = firstSpan(diagnostic);
  return createSignal({
    source: 'cargo-deny',
    category: 'security',
    severity: nativeLabelToSeverity(level, 'medium'),
    ruleId: ruleIdOf(diagnostic),
    message,
    code: {
      file: getString(span, 'file_name') ?? '',
      ...(getNumber(span, 'line_start') === undefined
        ? {}
        : { line: getNumber(span, 'line_start') }),
      ...(getNumber(span, 'column_start') === undefined
        ? {}
        : { column: getNumber(span, 'column_start') }),
    },
    metadata: withNativeSeverity({}, level ?? null),
  });
}

export function parseCargoDenyJsonLines(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const line of parseJsonLines(raw.raw, { tolerateNonJson: true }).values) {
    const signal = normalize(line.value);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
