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

function issueList(raw: ParsedScannerOutput): readonly unknown[] {
  const doc =
    raw.json === undefined
      ? (() => {
          const parsed = safeParseJson(raw.raw);
          return parsed.ok ? parsed.value : undefined;
        })()
      : raw.json;
  return asArray(asObject(doc)?.Issues) ?? [];
}

function normalize(entry: unknown): Signal | undefined {
  const issue = asObject(entry);
  if (issue === undefined) return undefined;
  const pos = asObject(issue.Pos);
  const linter = getString(issue, 'FromLinter') ?? 'golangci-lint';
  const severityLabel = getString(issue, 'Severity');
  return createSignal({
    source: 'golangci-lint',
    category: 'quality',
    severity: nativeLabelToSeverity(severityLabel, 'medium'),
    ruleId: linter,
    message: getString(issue, 'Text') ?? linter,
    code: {
      file: getString(pos, 'Filename') ?? '',
      ...(getNumber(pos, 'Line') === undefined ? {} : { line: getNumber(pos, 'Line') }),
      ...(getNumber(pos, 'Column') === undefined ? {} : { column: getNumber(pos, 'Column') }),
    },
    metadata: withNativeSeverity(
      {
        linter,
      },
      severityLabel ?? null,
    ),
  });
}

export function parseGolangciLintJson(
  raw: ParsedScannerOutput,
  _ctx: AdapterRunContext,
): readonly Signal[] {
  const signals: Signal[] = [];
  for (const entry of issueList(raw)) {
    const signal = normalize(entry);
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}
