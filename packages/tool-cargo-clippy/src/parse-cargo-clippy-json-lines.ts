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
  // rustc emits spanless AGGREGATE messages ("aborting due to N previous errors",
  // "N warnings emitted") as `compiler-message` records with `spans: []` and a null
  // `code`. They are not findings — skip them so they don't inflate the error count
  // with a bogus high-severity signal at an empty location.
  const span = firstPrimarySpan(message);
  if (span === undefined) return undefined;
  const code = asObject(message.code);
  const ruleId = getString(code, 'code') ?? 'clippy';
  const level = getString(message, 'level');
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

/**
 * Parse cargo clippy's `--message-format=json` NDJSON stream into signals. Keeps
 * only `compiler-message` records that carry a source span, dropping rustc's
 * spanless aggregate notes ("N warnings emitted") and non-diagnostic lines.
 */
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
