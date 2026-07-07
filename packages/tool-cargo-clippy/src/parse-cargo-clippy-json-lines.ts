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

function compilerMessage(value: unknown): Record<string, unknown> | undefined {
  const root = asObject(value);
  if (getString(root, 'reason') !== 'compiler-message') return undefined;
  return asObject(root?.message);
}

function firstPrimarySpan(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const spans = asArray(message.spans) ?? [];
  return asObject(spans.find((span) => asObject(span)?.is_primary === true) ?? spans[0]);
}

function normalize(message: Record<string, unknown>): Signal | undefined {
  const text = getString(message, 'message');
  if (text === undefined) return undefined;
  const code = asObject(message.code);
  const ruleId = getString(code, 'code') ?? 'clippy';
  const level = getString(message, 'level');
  const span = firstPrimarySpan(message);
  return createSignal({
    source: 'cargo-clippy',
    category: 'quality',
    severity: nativeLabelToSeverity(level, 'medium'),
    ruleId,
    message: text,
    code: {
      file: getString(span, 'file_name') ?? '',
      ...(getNumber(span, 'line_start') === undefined
        ? {}
        : { line: getNumber(span, 'line_start') }),
      ...(getNumber(span, 'column_start') === undefined
        ? {}
        : { column: getNumber(span, 'column_start') }),
    },
    metadata: withNativeSeverity(
      {
        explanation: getString(message, 'rendered') ?? null,
      },
      level ?? null,
    ),
  });
}

export function parseCargoClippyJsonLines(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const line of parseJsonLines(raw.raw, { tolerateNonJson: true }).values) {
    const message = compilerMessage(line.value);
    if (message === undefined) continue;
    const signal = normalize(message);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
